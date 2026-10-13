import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HostsFlag, HostsReport } from '../shared/hosts'

/*
 * hosts 文件体检（只读）。
 *
 * 存在的理由：联网体检能告诉你「github.com 解析到 127.0.0.1」，但说不出
 * **是谁改的**。真正的原因通常就在这个文件里，而它平时没人会去看。
 *
 * 判定只做三件确定的事，不做猜测：
 *   - 指向回环   → 域名被劫到本机
 *   - 指向黑洞   → 域名被主动屏蔽（0.0.0.0，广告拦截常用）
 *   - 命中发布链路域名 → 不管指到哪都值得看一眼
 * 局域网映射（192.168.x / 10.x 指向 .local 之类）**不报** —— 那是正常的开发用法，
 * 报出来只会稀释真正要看的那几条。
 */

const LOCALHOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'local',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-localnet',
  'ip6-mcastprefix',
  'ip6-allnodes',
  'ip6-allrouters'
])

/**
 * 发布链路域名：命中就值得在界面上单独点出来。
 *
 * 这份清单要克制 —— 它决定「什么算异常」。只放这台机器修东西时会用到的通道，
 * 不放全网常见域名（那样等于什么都报）。
 */
const WATCHED_DOMAINS = [
  'github.com',
  'api.github.com',
  'ssh.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'ghcr.io',
  'registry.npmjs.org',
  'registry.npmmirror.com',
  'npmmirror.com',
  'update.electronjs.org'
]

const LOOPBACK_RE = /^(127(\.\d{1,3}){3}|::1)$/i
const NULL_RE = /^(0\.0\.0\.0|::|0)$/
const MAX_FLAGS = 40
/** 读取上限：正常 hosts 只有几 KB，广告清单最大也就几百 KB */
const MAX_BYTES = 4 * 1024 * 1024

function hostsPath(): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  return join(root, 'System32', 'drivers', 'etc', 'hosts')
}

function isWatched(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return WATCHED_DOMAINS.some((domain) => lower === domain || lower.endsWith(`.${domain}`))
}

/**
 * 解码文件内容。
 *
 * hosts 文件三种编码都真实存在：无 BOM 的 ASCII/UTF-8（绝大多数）、
 * 带 BOM 的 UTF-8（被某些编辑器存过）、UTF-16LE（被 PowerShell 的
 * Out-File 默认写过）。按 BOM 判，不要猜。
 */
function decode(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  return buffer.toString('utf8')
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code ?? ''
  if (code === 'ENOENT') return '文件不存在'
  if (code === 'EACCES' || code === 'EPERM') return '权限不足，读不到（安全软件可能锁了它）'
  if (code === 'EBUSY') return '文件被占用，读不到'
  return error instanceof Error ? error.message : String(error)
}

const FLAG_ORDER: Record<HostsFlag['kind'], number> = { loopback: 0, null: 1, other: 2 }

/** 读一次 hosts 文件并给出判定（不写、不改） */
export function readHosts(): HostsReport {
  const path = hostsPath()
  const base: HostsReport = {
    path,
    exists: false,
    readable: false,
    totalLines: 0,
    entries: 0,
    defaults: 0,
    flags: [],
    omitted: 0,
    modifiedAt: null
  }

  let text: string
  try {
    const stats = statSync(path)
    base.exists = true
    // 取整：mtimeMs 是浮点，直接传进渲染层会在时间戳上带一串小数
    base.modifiedAt = Math.round(stats.mtimeMs)
    const raw = readFileSync(path)
    text = decode(raw.length > MAX_BYTES ? raw.subarray(0, MAX_BYTES) : raw)
    base.readable = true
  } catch (error) {
    return { ...base, error: describeError(error) }
  }

  const lines = text.split(/\r?\n/)
  base.totalLines = lines.length

  const flags: HostsFlag[] = []
  let entries = 0
  let defaults = 0

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    // 剥注释：`#` 之后全丢（hosts 没有转义，`#` 就是终止符）
    const hash = lines[index].indexOf('#')
    const body = (hash >= 0 ? lines[index].slice(0, hash) : lines[index]).trim()
    if (body.length === 0) continue

    const tokens = body.split(/\s+/)
    if (tokens.length < 2) continue
    const ip = tokens[0]
    const hostnames = tokens.slice(1)

    entries++

    // 系统默认的 localhost 家族：单独计数，不当异常
    if (hostnames.every((name) => LOCALHOST_NAMES.has(name.toLowerCase()))) {
      defaults++
      continue
    }

    for (const hostname of hostnames) {
      if (LOCALHOST_NAMES.has(hostname.toLowerCase())) continue
      const watched = isWatched(hostname)
      const loopback = LOOPBACK_RE.test(ip)
      const nullish = NULL_RE.test(ip)
      if (!loopback && !nullish && !watched) continue
      flags.push({
        line: lineNumber,
        ip,
        hostname,
        kind: loopback ? 'loopback' : nullish ? 'null' : 'other',
        watched
      })
    }
  }

  // 排序即优先级：先发布链路域名，再按判定类型 —— 否则几千条广告拦截会把唯一
  // 那条 github.com 淹掉，而这正是用户打开这个面板要找的东西
  flags.sort((a, b) => {
    if (a.watched !== b.watched) return a.watched ? -1 : 1
    if (a.kind !== b.kind) return FLAG_ORDER[a.kind] - FLAG_ORDER[b.kind]
    return a.line - b.line
  })

  base.entries = entries
  base.defaults = defaults
  base.omitted = Math.max(0, flags.length - MAX_FLAGS)
  base.flags = flags.slice(0, MAX_FLAGS)
  return base
}
