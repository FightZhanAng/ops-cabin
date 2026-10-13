import { execFile } from 'node:child_process'
import type { AutoOp, AutoResult } from '../shared/auto'
import type { StartupItem, StartupReport, StartupSource } from '../shared/startup'
import type { TaskItem, TaskReport } from '../shared/tasks'
import { runPowerShell } from './powershell'

/*
 * 可写操作的唯一实现方（开机自启 / 计划任务的禁用启用与删除登记）。
 *
 * 安全边界（见 docs/adr/0001-写操作提权.md）：
 *   · 渲染层只传 id —— 键路径、值名、文件路径一律从**刚重采集的报告**里重建；
 *     报告里找不到（stale）就拒绝，绝不用渲染层传的字符串拼命令；
 *   · 进 PowerShell 的动态字符串一律 base64 —— 引号、分号、中文都破坏不了脚本；
 *   · 需要管理员的来源走提权通道（deps.elevate），助手执行的是**同一份**
 *     executeStartupOp —— 不存在绕过校验的旁路。
 */

/** 启用位所在键（与采集端的六个 StartupApproved 键一一对应） */
const APPROVED_BASE = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved'

const SOURCE_APPROVED: Record<StartupSource, { hive: 'HKCU' | 'HKLM'; sub: string }> = {
  'registry-hkcu': { hive: 'HKCU', sub: 'Run' },
  'registry-hklm': { hive: 'HKLM', sub: 'Run' },
  'registry-hklm-wow': { hive: 'HKLM', sub: 'Run32' },
  'folder-user': { hive: 'HKCU', sub: 'StartupFolder' },
  'folder-common': { hive: 'HKLM', sub: 'StartupFolder' }
}

/** 登记所在的原始键（删除登记删的就是它）；文件夹来源没有注册表键 —— 删的是 .lnk 文件 */
const SOURCE_RUN_KEY: Record<StartupSource, string | null> = {
  'registry-hkcu': 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'registry-hklm': 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'registry-hklm-wow': 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
  'folder-user': null,
  'folder-common': null
}

/** 需要管理员权限的来源（提权后由受控助手执行，见 elevate.ts） */
const ADMIN_SOURCES = new Set<StartupSource>(['registry-hklm', 'registry-hklm-wow', 'folder-common'])

export interface AutoDeps {
  startupReport: (force: boolean) => Promise<StartupReport>
  taskReport: (force: boolean) => Promise<TaskReport>
  /** 提权通道（002）：需要管理员的动作经受控助手执行；注入以便直写路径与它解耦 */
  elevate: (op: AutoOp) => Promise<AutoResult>
}

/** 助手请求文件里装的东西（与 op 分开是为了防陈旧文件被误执行） */
export interface HelperPayload {
  nonce: string
  at: number
  op: AutoOp
}

const NONCE_FORM = /^[0-9a-f]{32}$/
/** 请求文件的新鲜度上限：过期的（被攒下的）请求一律拒绝 */
const PAYLOAD_FRESH_MS = 5 * 60_000

/** 校验助手请求内容（结构 + 时间窗 + 封闭操作集：启动项与计划任务两域） */
export function isValidHelperPayload(raw: unknown): raw is HelperPayload {
  if (raw === null || typeof raw !== 'object') return false
  const rec = raw as Record<string, unknown>
  if (typeof rec.nonce !== 'string' || !NONCE_FORM.test(rec.nonce)) return false
  if (typeof rec.at !== 'number' || Math.abs(Date.now() - rec.at) > PAYLOAD_FRESH_MS) return false
  const op = parseAutoOp(rec.op)
  return op !== null
}

/** 校验渲染层入参；不合法返回 null（调用方回 invalid） */
export function parseAutoOp(raw: unknown): AutoOp | null {
  if (raw === null || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const target = rec.target === 'startup' || rec.target === 'task' ? rec.target : null
  const action = rec.action === 'toggle' || rec.action === 'delete' ? rec.action : null
  const id = typeof rec.id === 'string' && rec.id.length > 0 && rec.id.length <= 1024 ? rec.id : null
  if (target === null || action === null || id === null) return null
  if (action === 'toggle' && typeof rec.enabled !== 'boolean') return null
  const op: AutoOp = { target, action, id }
  if (typeof rec.enabled === 'boolean') op.enabled = rec.enabled
  return op
}

export async function applyAutoOp(raw: unknown, deps: AutoDeps): Promise<AutoResult> {
  const op = parseAutoOp(raw)
  if (op === null) return { ok: false, reason: 'invalid', message: '操作参数不合法' }
  if (op.target === 'task') return applyTaskOp(op, deps)
  return applyStartupOp(op, deps)
}

async function applyTaskOp(op: AutoOp, deps: AutoDeps): Promise<AutoResult> {
  // 与启动项同一套复核：id 对不上 = 条目已变化或渲染层伪造 —— 一律拒绝
  const report = await deps.taskReport(true)
  if (report.error !== undefined) {
    return { ok: false, reason: 'failed', message: `读取当前状态失败：${report.error}` }
  }
  const item = report.items.find((entry) => entry.id === op.id)
  if (item === undefined) {
    return { ok: false, reason: 'stale', message: '条目已变化 —— 请刷新后重试' }
  }
  const direct = await executeTaskOp(item, op)
  // 权限不足：任务自身改不了（任务 ACL 不给当前用户）→ 才走提权通道。
  // 先直写后提权（不是无条件弹 UAC）：用户自己建的任务在多数机器上本就能改。
  if (!direct.ok && direct.reason === 'needs-admin') return deps.elevate(op)
  return direct
}

/** 单条任务操作的执行 —— 直写路径与提权助手共用同一实现 */
export async function executeTaskOp(item: TaskItem, op: AutoOp): Promise<AutoResult> {
  if (op.action === 'delete') {
    // S9：删除只对「路径失效」的任务开放（与行上的档位同一判据）；
    // 已禁用的任务即使路径没了也不算 —— 那是 'disabled' 档
    if (item.state !== 'missing') {
      return { ok: false, reason: 'denied', message: '仅路径失效的任务可删除' }
    }
    return deleteTask(item)
  }
  return changeTaskEnabled(item, op.enabled === true)
}

/** 删除任务定义（`schtasks /Delete /F`；直接删除不进回收站，与启动项同口径） */
async function deleteTask(item: TaskItem): Promise<AutoResult> {
  const { code, out } = await runSchtasks(['/Delete', '/TN', item.id, '/F'])
  if (code === 0) return { ok: true }
  if (/拒绝访问|access is denied/i.test(out)) {
    return { ok: false, reason: 'needs-admin', message: '这一项需要管理员权限' }
  }
  // 已经被外部删掉了：目标已达成，按成功上报（随后强制重读，行会消失）
  if (/找不到|cannot find|does not exist/i.test(out)) return { ok: true }
  return { ok: false, reason: 'failed', message: out.length > 0 ? out : `schtasks 退出码 ${code}` }
}

/**
 * schtasks `/Change /TN <任务全路径> /ENABLE|/DISABLE`。
 *
 * 不用 runPowerShell：schtasks 的输出是 OEM 代码页（中文机器上是 GBK），而
 * runPowerShell 会把控制台改成 UTF-8 —— 中文错误信息在那条通道里全是乱码，
 * 「拒绝访问」和「找不到了」就分不开。这里直接 execFile，显式按 GBK 解码；
 * 英文系统上 GBK 解码对 ASCII 无损，英文关键词照样能匹配。
 */
function runSchtasks(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'schtasks.exe',
      args,
      { windowsHide: true, encoding: 'buffer', timeout: 20000 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1
        let decode: (buffer: Buffer) => string
        try {
          const gbk = new TextDecoder('gbk')
          decode = (buffer) => gbk.decode(buffer)
        } catch {
          decode = (buffer) => buffer.toString('utf8')
        }
        const out = `${decode(stdout)}${decode(stderr)}`.trim()
        resolve({ code, out })
      }
    )
  })
}

async function changeTaskEnabled(item: TaskItem, enabled: boolean): Promise<AutoResult> {
  const { code, out } = await runSchtasks([
    '/Change',
    '/TN',
    item.id,
    enabled ? '/ENABLE' : '/DISABLE'
  ])
  if (code === 0) return { ok: true }
  if (/拒绝访问|access is denied/i.test(out)) {
    return { ok: false, reason: 'needs-admin', message: '这一项需要管理员权限' }
  }
  if (/找不到|cannot find|does not exist/i.test(out)) {
    return { ok: false, reason: 'stale', message: '任务已不存在 —— 请刷新后重试' }
  }
  return { ok: false, reason: 'failed', message: out.length > 0 ? out : `schtasks 退出码 ${code}` }
}

async function applyStartupOp(op: AutoOp, deps: AutoDeps): Promise<AutoResult> {
  // 从刚重采集的报告里复核：id 对不上 = 条目已变化或渲染层伪造 —— 一律拒绝
  const report = await deps.startupReport(true)
  if (report.error !== undefined) {
    return { ok: false, reason: 'failed', message: `读取当前状态失败：${report.error}` }
  }
  const item = report.items.find((entry) => entry.id === op.id)
  if (item === undefined) {
    return { ok: false, reason: 'stale', message: '条目已变化 —— 请刷新后重试' }
  }
  if (ADMIN_SOURCES.has(item.source)) {
    return deps.elevate(op)
  }
  return executeStartupOp(item, op)
}

/** 单条启动项操作的执行 —— 直写路径与提权助手共用同一实现 */
export async function executeStartupOp(item: StartupItem, op: AutoOp): Promise<AutoResult> {
  if (op.action === 'delete') {
    // S6 / D2：只有「可判定的路径不存在」的条目可删；禁用与否不限制。
    // UI 不给入口只是第一道 —— 伪造请求同样过不了这里（助手也走这份实现，无旁路）
    if (item.pathExists) {
      return { ok: false, reason: 'denied', message: '仅路径失效的条目可删除' }
    }
    return deleteStartupEntry(item)
  }
  return writeEnabled(item, op.enabled === true)
}

/** 删除登记（D7：直接删除不进回收站；只删登记，不碰程序本体） */
async function deleteStartupEntry(item: StartupItem): Promise<AutoResult> {
  const runKey = SOURCE_RUN_KEY[item.source]
  const approvedKey = `${SOURCE_APPROVED[item.source].hive}:\\${APPROVED_BASE}\\${SOURCE_APPROVED[item.source].sub}`
  const script =
    runKey !== null
      ? buildDeleteValueScript(runKey, item.entryName, approvedKey)
      : buildDeleteFileScript(item.command, approvedKey, item.entryName)
  const out = await runPowerShell(script, 20000).catch(
    (error: unknown) => `ERR ${error instanceof Error ? error.message : String(error)}`
  )
  const text = out.trim()
  if (text === 'OK') return { ok: true }
  return { ok: false, reason: 'failed', message: text.length > 0 ? text : '删除未确认' }
}

/** 写启用位：翻转 StartupApproved 首字节（0x03 禁用 / 0x02 启用），其余字节原样保留 */
async function writeEnabled(item: StartupItem, enabled: boolean): Promise<AutoResult> {
  const source = SOURCE_APPROVED[item.source]
  const keyPath = `${source.hive}:\\${APPROVED_BASE}\\${source.sub}`
  const out = await runPowerShell(buildEnableScript(keyPath, item.entryName, enabled), 20000).catch(
    (error: unknown) => `ERR ${error instanceof Error ? error.message : String(error)}`
  )
  const text = out.trim()
  if (text === 'OK') return { ok: true }
  return { ok: false, reason: 'failed', message: text.length > 0 ? text : '写入未确认' }
}

/** 动态字符串一律 base64 进脚本 —— 注册表值名/文件名里什么字符都可能出现 */
function b64(text: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'))`
}

function buildEnableScript(keyPath: string, valueName: string, enabled: boolean): string {
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $key = ${b64(keyPath)}`,
    `  $name = ${b64(valueName)}`,
    `  $enable = ${enabled ? '$true' : '$false'}`,
    '  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }',
    '  # 写必须走 Set-ItemProperty：Get-Item 拿到的句柄没有写权限，',
    '  # 直接 .SetValue() 会报「无法写入到注册表项」（本机实测，2026-10-13）',
    '  $raw = (Get-Item -LiteralPath $key).GetValue($name)',
    '  if ($raw -is [byte[]] -and $raw.Length -ge 1) {',
    '    $bytes = [byte[]]$raw.Clone()',
    '    if ($enable) { $bytes[0] = [byte]2 } else { $bytes[0] = [byte]3 }',
    '  } else {',
    '    # 值不存在（或形态不对）：按任务管理器口径新建 12 字节（首字节 + 8 字节 FILETIME）',
    '    $bytes = New-Object byte[] 12',
    '    if ($enable) { $bytes[0] = [byte]2 } else { $bytes[0] = [byte]3 }',
    '    $stamp = [BitConverter]::GetBytes([DateTime]::Now.ToFileTime())',
    '    [Array]::Copy($stamp, 0, $bytes, 1, 8)',
    '  }',
    '  Set-ItemProperty -LiteralPath $key -Name $name -Value $bytes -Type Binary',
    '  $check = (Get-Item -LiteralPath $key).GetValue($name)',
    '  if ($check -is [byte[]] -and $check.Length -ge 1 -and $check[0] -eq $bytes[0]) { "OK" }',
    '  else { "ERR 写入校验失败" }',
    '} catch {',
    '  "ERR " + $_.Exception.Message',
    '}'
  ].join('\n')
}

/**
 * 启用位清理（删除登记后的收尾）—— 尽力而为，失败不影响删除结论。
 * 必须单独 try 包住：键不存在（本来就没启用过）是常态而非错误。
 */
function approvedCleanupLines(approvedKey: string, valueName: string): string[] {
  return [
    '  try {',
    `    $ak = ${b64(approvedKey)}`,
    `    $an = ${b64(valueName)}`,
    '    if (Test-Path -LiteralPath $ak) { Remove-ItemProperty -LiteralPath $ak -Name $an -ErrorAction SilentlyContinue }',
    '  } catch { }'
  ]
}

/** 删除注册表登记（Run 值）；删后回读校验，值确实不在才算 OK */
function buildDeleteValueScript(runKey: string, valueName: string, approvedKey: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $key = ${b64(runKey)}`,
    `  $name = ${b64(valueName)}`,
    '  if ((Get-Item -LiteralPath $key).GetValueNames() -contains $name) {',
    '    Remove-ItemProperty -LiteralPath $key -Name $name',
    '  }',
    '  if ((Get-Item -LiteralPath $key).GetValueNames() -contains $name) {',
    '    "ERR 删除校验失败"',
    '  } else {',
    ...approvedCleanupLines(approvedKey, valueName),
    '    "OK"',
    '  }',
    '} catch {',
    '  "ERR " + $_.Exception.Message',
    '}'
  ].join('\n')
}

/** 删除启动文件夹里的 .lnk；文件本就不在时视为已达成（幂等），删后回读校验 */
function buildDeleteFileScript(filePath: string, approvedKey: string, valueName: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $file = ${b64(filePath)}`,
    '  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }',
    '  if (Test-Path -LiteralPath $file) {',
    '    "ERR 删除校验失败"',
    '  } else {',
    ...approvedCleanupLines(approvedKey, valueName),
    '    "OK"',
    '  }',
    '} catch {',
    '  "ERR " + $_.Exception.Message',
    '}'
  ].join('\n')
}
