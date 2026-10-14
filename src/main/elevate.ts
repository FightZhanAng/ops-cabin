import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutoFailReason, AutoOp, AutoResult } from '../shared/auto'
import { type HelperPayload } from './autoapply'
import { runPowerShell } from './powershell'
import { SMOKE } from './smoke'

/*
 * 按需提权（002）：需要管理员的写操作走「应用自身当助手」——
 * 主进程把 op 写进临时请求文件，Start-Process -Verb RunAs 以管理员身份再启动
 * 一个本应用实例（--apply-op），助手执行完把结果写回结果文件。
 * UAC 弹窗上的应用身份因此是「运维舱」而不是 PowerShell。取舍与威胁模型见 docs/adr/0001。
 */

/** 给 UAC 弹窗留足应答时间；超时按失败上报，不做静默重试 */
const ELEVATE_TIMEOUT_MS = 120_000

const FAIL_REASONS: readonly AutoFailReason[] = [
  'invalid',
  'stale',
  'needs-admin',
  'cancelled',
  'denied',
  'failed'
]

function psSingle(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

export async function elevateAutoOp(op: AutoOp): Promise<AutoResult> {
  /*
   * 自检下不弹 UAC：自动化里没人应答，弹窗会把 e2e 挂死。
   * 真实弹窗链路（同意 / 取消两个分支）无法自动化 —— 进人工清单，强度如实记录。
   */
  if (SMOKE) return { ok: false, reason: 'needs-admin', message: '自检模式下不触发 UAC' }

  const nonce = randomBytes(16).toString('hex')
  const payloadFile = join(tmpdir(), `ops-cabin-apply-${nonce}.json`)
  const resultFile = `${payloadFile}.result`
  const payload: HelperPayload = { nonce, at: Date.now(), op }
  /*
   * 用 'wx' 独占创建：文件已存在就直接失败（EEXIST），绝不覆盖。
   *
   * 这样至少封死「预置一个同命名规则的文件、等我们写进去」与「在写入前占位」
   * 这两种做法 —— nonce 是 16 字节随机，攻击者猜不到名字，但他可以让目录里
   * 预先堆满候选名，或者让写入落到一个已有硬链接上。独占标志把这条路堵掉。
   *
   * 注意威胁模型如实说明：这挡不住「同用户进程在写入之后、助手读取之前改写
   * 文件内容」（TOCTOU）—— 那需要把参数挪出可写文件（改走命令行）才能根治，
   * 属于待办，见 docs/adr/0001 与 CODE-REVIEW-REPORT.md 的问题 #1。
   */
  try {
    writeFileSync(payloadFile, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      ok: false,
      reason: 'failed',
      message:
        code === 'EEXIST'
          ? '请求文件已被占用（可能有同名文件），已中止提权'
          : `无法准备提权请求：${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    const args = app.isPackaged
      ? `--apply-op "${payloadFile}"`
      : `"${app.getAppPath()}" --apply-op "${payloadFile}"`
    const script = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      `  Start-Process -FilePath ${psSingle(process.execPath)} -ArgumentList ${psSingle(args)} -Verb RunAs -Wait | Out-Null`,
      '  "OK"',
      '} catch {',
      '  "ERR " + $_.Exception.Message',
      '}'
    ].join('\n')
    const out = (
      await runPowerShell(script, ELEVATE_TIMEOUT_MS).catch(
        (error: unknown) => `ERR ${error instanceof Error ? error.message : String(error)}`
      )
    ).trim()

    // UAC 取消：Start-Process 抛「操作已被用户取消」（1223）—— 按取消上报，不算失败
    if (out !== 'OK') {
      if (/取消|cancel/i.test(out)) {
        return { ok: false, reason: 'cancelled', message: '已取消（未提权）' }
      }
      return { ok: false, reason: 'failed', message: out.length > 0 ? out : '提权调用未返回结果' }
    }
    if (!existsSync(resultFile)) {
      return { ok: false, reason: 'failed', message: '提权助手未返回结果' }
    }
    return normalizeHelperResult(readFileSync(resultFile, 'utf8'))
  } finally {
    // 成功 / 失败 / 取消都不留临时文件
    /*
     * 清理失败也必须咽下去：`force: true` 只忽略 ENOENT，文件被杀软 / 索引器 /
     * 提权助手持有时会抛 EPERM / EBUSY。而这里在 `finally` 里 —— 抛出去会把
     * 一个**已经成功的提权结果**替换成异常，调用方拿到 reject 而不是
     * `{ ok: true }`，用户看到「操作失败」而实际上启用位已经改好了。
     * 残留的两个临时文件无害（助手下次不会再用同一个 nonce）。
     */
    try {
      rmSync(payloadFile, { force: true })
    } catch {
      /* 残留无害，不覆盖真实结果 */
    }
    try {
      rmSync(resultFile, { force: true })
    } catch {
      /* 同上 */
    }
  }
}

/** 解析助手写回的结果文件；坏内容不伪装成成功 */
function normalizeHelperResult(text: string): AutoResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'failed', message: '提权助手返回的结果无法解析' }
  }
  if (parsed !== null && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true) {
    return { ok: true }
  }
  const rec = (parsed ?? {}) as Record<string, unknown>
  const reason =
    typeof rec.reason === 'string' && (FAIL_REASONS as readonly string[]).includes(rec.reason)
      ? (rec.reason as AutoFailReason)
      : 'failed'
  const message = typeof rec.message === 'string' && rec.message.length > 0 ? rec.message : undefined
  return { ok: false, reason, ...(message !== undefined ? { message } : {}) }
}
