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
  writeFileSync(payloadFile, JSON.stringify(payload), 'utf8')
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
    rmSync(payloadFile, { force: true })
    rmSync(resultFile, { force: true })
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
