import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { connect } from 'node:net'
import type { NetCheckItem, NetCheckReport } from '../shared/net'
import { runPowerShell } from './powershell'

/*
 * 联网体检：把「发版卡在网络上还是卡在代码上」这个问题在 5 秒内回答掉。
 *
 * 探的都是本机发布链路上真实会拦人的关口：
 *   - 域名解析（DNS 被污染/劫持时后面全是超时，先定位到这一层）
 *   - github.com:443（HTTPS / git over https）
 *   - github.com:22（SSH 默认端口，受限网络最常见的被拒点）
 *   - ssh.github.com:443（SSH-over-443 备用通道，22 被拒时的出路）
 *   - api.github.com（更新检查走这里，顺带看匿名 API 配额）
 *   - 系统代理 / 环境变量（Electron 与 git 可能走不同代理，先看清楚）
 *
 * 全部并行探测：总耗时 = 最慢的一项，不是各项之和。
 */

const DNS_TIMEOUT = 4000
const TCP_TIMEOUT = 5000
const HTTP_TIMEOUT = 6000

const GITHUB = 'github.com'
const SSH_HOST = 'ssh.github.com'
const API_HOST = 'api.github.com'

/** 带超时的 promise；超时用 onTimeout 的值兜底 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(onTimeout())
      }
    )
  })
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 把网络错误转成人话。
 *
 * Node 的原始报文（「certificate signature failure」「connect ECONNREFUSED
 * 127.0.0.1:22」）在界面上会被截断成半句，而恰恰是最关键的那半句 ——
 * 尤其证书错误：那不是「不通」，是本地代理在做 TLS 拦截。原始报文留在 title 里备查。
 */
function describeNetworkError(error: unknown): string {
  const raw = message(error)
  const nodeError = error as NodeJS.ErrnoException
  const lower = `${raw} ${nodeError.code ?? ''}`.toLowerCase().replace(/[-_]/g, ' ')
  if (lower.includes('certificate') || lower.includes('self signed') || lower.includes('issuer')) {
    return '证书不受信任（本地代理可能做了 TLS 拦截）'
  }
  if (lower.includes('econnrefused')) return '连接被拒 —— 没有进程在监听'
  if (lower.includes('etimedout') || lower.includes('timeout')) return '超时 —— 端口没响应'
  if (lower.includes('enotfound') || lower.includes('eai again')) return '域名解析不到'
  if (lower.includes('econnreset')) return '连接被重置（中间设备切断）'
  return raw.slice(0, 60)
}

interface TcpResult {
  ok: boolean
  ms: number
  error: string
}

/** 只做 TCP 握手，不发数据 —— 连得上说明端口没被拦 */
function probeTcp(host: string, port: number): Promise<TcpResult> {
  return new Promise<TcpResult>((resolve) => {
    const started = Date.now()
    const socket = connect({ host, port })
    let settled = false
    const finish = (result: TcpResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(TCP_TIMEOUT)
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - started, error: '' }))
    socket.once('timeout', () =>
      finish({ ok: false, ms: Date.now() - started, error: `超过 ${TCP_TIMEOUT / 1000}s 无响应` })
    )
    socket.once('error', (error: Error) =>
      finish({ ok: false, ms: Date.now() - started, error: error.message })
    )
  })
}

/** 回环地址：域名叫到本机，通常意味着 hosts 改写或本地代理在接管 */
function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.')
}

async function probeDns(): Promise<NetCheckItem> {
  const started = Date.now()
  const result = await withTimeout(
    lookup(GITHUB).catch((error: unknown) => ({ address: '', family: 0, failure: message(error) })),
    DNS_TIMEOUT,
    () => ({ address: '', family: 0, failure: `超过 ${DNS_TIMEOUT / 1000}s 无响应` })
  )
  const ms = Date.now() - started
  if (result.address) {
    // 指向本机不是错，但必须说出来 —— 后面 443/22 通不通全由这个本地代理决定，
    // 只报「解析成功」会让人以为走的是真 GitHub
    const note = isLoopback(result.address) ? ' · 本机代理或 hosts 改写' : ''
    return {
      id: 'dns',
      label: '域名解析',
      state: 'ok',
      detail: `${GITHUB} → ${result.address}${note}`,
      ms
    }
  }
  const failure = 'failure' in result ? result.failure : '解析失败'
  return { id: 'dns', label: '域名解析', state: 'fail', detail: failure, ms }
}

async function probePort(host: string, port: number, label: string, note: string): Promise<NetCheckItem> {
  const result = await probeTcp(host, port)
  return {
    id: `tcp-${port}`,
    label,
    state: result.ok ? 'ok' : 'fail',
    detail: result.ok
      ? `${host}:${port} 已连通 · ${note}`
      : `${host}:${port} ${describeNetworkError(result.error)}`,
    ms: result.ms
  }
}

interface HttpResult {
  ok: boolean
  /** 通道其实通、只是证书不被信任（本地代理 TLS 拦截）：既不算通过也不算不通 */
  untrusted: boolean
  detail: string
}

/** 发起一次 HTTPS 请求；insecure 时接受不受信任的证书 */
function httpsGet(insecure: boolean): Promise<{ status: number; remaining: string | null }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: API_HOST,
        path: '/rate_limit',
        method: 'GET',
        timeout: HTTP_TIMEOUT,
        rejectUnauthorized: !insecure,
        headers: { 'User-Agent': 'ops-cabin', Accept: 'application/vnd.github+json' }
      },
      (res) => {
        const remaining = res.headers['x-ratelimit-remaining']
        res.resume()
        resolve({
          status: res.statusCode ?? 0,
          remaining: remaining ? String(remaining) : null
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.on('error', (error: Error) => reject(error))
    req.end()
  })
}

function isCertError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException
  // 报文与 error.code 一起看，并把连字符/下划线归一：Node 实际给的是
  // 「self-signed certificate」+ code「DEPTH_ZERO_SELF_SIGNED_CERT」，
  // 只按空格写法匹配会漏（这里踩过）。
  const text = `${message(error)} ${nodeError.code ?? ''}`.toLowerCase().replace(/[-_]/g, ' ')
  return (
    text.includes('certificate') ||
    text.includes('self signed') ||
    text.includes('issuer') ||
    text.includes('cert ')
  )
}

/**
 * GET api.github.com：顺带读匿名 API 剩余配额（更新检查走的就是这条通道）。
 *
 * 证书不受信任时会**再试一次**（rejectUnauthorized: false）—— 只为了区分
 * 「通道被拦」和「通道通、但证书是本地代理签的」。后者不是故障：很多工具配好
 * 证书后照样能用，而一刀切成「不通」会把人引到错误的方向去查。
 */
async function probeApi(): Promise<HttpResult> {
  try {
    const result = await httpsGet(false)
    const ok = result.status >= 200 && result.status < 400
    return {
      ok,
      untrusted: false,
      detail: result.remaining
        ? `HTTP ${result.status} · 匿名配额剩 ${result.remaining}`
        : `HTTP ${result.status}`
    }
  } catch (error) {
    if (!isCertError(error)) {
      return { ok: false, untrusted: false, detail: describeNetworkError(error) }
    }
    try {
      const retry = await httpsGet(true)
      const ok = retry.status >= 200 && retry.status < 400
      return {
        ok,
        untrusted: true,
        detail: ok
          ? `HTTP ${retry.status} · 证书不受信任但通道可用（本地代理 TLS 拦截）`
          : `证书不受信任，放宽后仍返回 HTTP ${retry.status}`
      }
    } catch (retryError) {
      return {
        ok: false,
        untrusted: false,
        detail: `证书不受信任，且放宽后仍失败：${describeNetworkError(retryError)}`
      }
    }
  }
}

async function probeApiItem(): Promise<NetCheckItem> {
  const started = Date.now()
  const result = await probeApi()
  return {
    id: 'api',
    label: 'GitHub API',
    // 通道通但证书是本地代理签的：算读数（不计入通过数），不是故障
    state: result.ok ? (result.untrusted ? 'info' : 'ok') : 'fail',
    detail: result.detail,
    ms: Date.now() - started
  }
}

/** 读系统代理与代理环境变量：两边可能不一致，所以分开报 */
async function probeProxy(): Promise<NetCheckItem> {
  const envProxy =
    process.env['HTTPS_PROXY'] ??
    process.env['https_proxy'] ??
    process.env['HTTP_PROXY'] ??
    process.env['http_proxy'] ??
    ''

  let registry: string | null = null
  try {
    const script = [
      "$k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop",
      '$out = @()',
      'if ($k.ProxyEnable -eq 1 -and $k.ProxyServer) { $out += "SERVER=" + $k.ProxyServer }',
      'if ($k.AutoConfigURL) { $out += "PAC=" + $k.AutoConfigURL }',
      '$out -join "|"'
    ].join('\n')
    const output = (await runPowerShell(script, 8000)).trim()
    registry = output.length > 0 ? output : null
  } catch {
    registry = null
  }

  const parts: string[] = []
  if (registry) {
    for (const piece of registry.split('|')) {
      parts.push(piece.startsWith('PAC=') ? `PAC ${piece.slice(4)}` : `系统代理 ${piece.slice(7)}`)
    }
  }
  if (envProxy) parts.push(`环境变量 ${envProxy}`)

  return {
    id: 'proxy',
    label: '代理设置',
    state: 'info',
    detail: parts.length > 0 ? parts.join(' · ') : '未配置 —— 直连',
    ms: null
  }
}

/** 跑一次完整体检（全部并行） */
export async function runNetCheck(): Promise<NetCheckReport> {
  const items = await Promise.all([
    probeDns(),
    probePort(GITHUB, 443, 'GitHub HTTPS', 'HTTPS 抓取'),
    probePort(GITHUB, 22, 'GitHub SSH', 'SSH 推送'),
    probePort(SSH_HOST, 443, 'SSH-over-443', '22 被拒时的备用通道'),
    probeApiItem(),
    probeProxy()
  ])

  const counted = items.filter((item) => item.state !== 'info')
  return {
    at: Date.now(),
    items,
    passed: counted.filter((item) => item.state === 'ok').length,
    total: counted.length
  }
}
