import type { StartupItem, StartupReport, StartupSource } from '../shared/startup'
import { isExecPathValid, parseExecPath } from './execpath'
import { runPowerShell } from './powershell'

/*
 * 开机自启清单（只读）。
 *
 * 为什么不用 Win32_StartupCommand：它在现代 Windows 上覆盖不全（漏 WOW6432Node、
 * 漏 StartupApproved 里被禁用的项），而「漏掉一条」比「多列一条」更糟 —— 用户会
 * 以为自己看全了。这里直接走三个 Run 键 + 两个启动文件夹，来源明确、可回溯。
 *
 * 字段分隔符用 US(0x1f)、记录分隔符用 RS(0x1e)，不用 `|` 或换行：注册表值里
 * 完全可能出现 `|`，命令行理论上也可能带换行。控制字符在 -EncodedCommand 的
 * UTF-16 通道里是安全的。
 */

const FIELD = '\u001f'
const RECORD = '\u001e'

const PS_SCRIPT = [
  '$FS = [char]31',
  '$RS = [char]30',
  '$out = New-Object System.Collections.ArrayList',
  '',
  '# 任务管理器把「已禁用」记在这里：首字节 0x03 为禁用，0x02 / 0x06 为启用。',
  '# 不读它就会把已经禁掉的自启项继续当成「每次开机都在跑」。',
  '$approved = @{}',
  '$approvedKeys = @(',
  "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',",
  "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32',",
  "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',",
  "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32',",
  "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder',",
  "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'",
  ')',
  'foreach ($k in $approvedKeys) {',
  '  if (-not (Test-Path $k)) { continue }',
  '  $item = Get-Item $k -ErrorAction SilentlyContinue',
  '  if ($null -eq $item) { continue }',
  '  foreach ($n in $item.GetValueNames()) {',
  '    if ([string]::IsNullOrEmpty($n)) { continue }',
  '    $b = $item.GetValue($n)',
  '    if ($b -is [byte[]] -and $b.Length -gt 0) { $approved[$n] = ($b[0] -ne 3) }',
  '  }',
  '}',
  '',
  'function Get-ApprovedFlag([string]$name) {',
  '  if ($approved.ContainsKey($name)) { if ($approved[$name]) { return "1" } else { return "0" } }',
  '  return "1"',
  '}',
  '',
  '$runKeys = @(',
  "  @{ Path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Source = 'registry-hkcu' },",
  "  @{ Path = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Source = 'registry-hklm' },",
  "  @{ Path = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; Source = 'registry-hklm-wow' }",
  ')',
  'foreach ($rk in $runKeys) {',
  '  if (-not (Test-Path $rk.Path)) { continue }',
  '  $item = Get-Item $rk.Path -ErrorAction SilentlyContinue',
  '  if ($null -eq $item) { continue }',
  '  foreach ($n in $item.GetValueNames()) {',
  '    if ([string]::IsNullOrEmpty($n)) { continue }',
  '    $raw = [string]$item.GetValue($n)',
  "    $expanded = [Environment]::ExpandEnvironmentVariables($raw)",
  "    [void]$out.Add('REG' + $FS + $rk.Source + $FS + $n + $FS + $expanded + $FS + (Get-ApprovedFlag $n))",
  '  }',
  '}',
  '',
  '$folders = @(',
  "  @{ Path = (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'); Source = 'folder-user' },",
  "  @{ Path = (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'); Source = 'folder-common' }",
  ')',
  'foreach ($f in $folders) {',
  '  if (-not (Test-Path $f.Path)) { continue }',
  '  Get-ChildItem -LiteralPath $f.Path -File -Force -ErrorAction SilentlyContinue | ForEach-Object {',
  "    [void]$out.Add('DIR' + $FS + $f.Source + $FS + $_.Name + $FS + $_.FullName + $FS + (Get-ApprovedFlag $_.Name))",
  '  }',
  '}',
  '',
  '$out -join $RS'
].join('\n')

const SOURCES: readonly StartupSource[] = [
  'registry-hkcu',
  'registry-hklm',
  'registry-hklm-wow',
  'folder-user',
  'folder-common'
]

function isSource(value: string): value is StartupSource {
  return (SOURCES as readonly string[]).includes(value)
}

function parseOutput(output: string): { items: StartupItem[]; degraded: boolean } {
  const items: StartupItem[] = []
  let degraded = false

  for (const record of output.split(RECORD)) {
    const text = record.trim()
    if (text.length === 0) continue
    const fields = text.split(FIELD)
    if (fields.length < 5) {
      degraded = true
      continue
    }
    const [, source, entryName, command, approved] = fields
    if (!isSource(source)) {
      degraded = true
      continue
    }
    const path = parseExecPath(command)
    const valid = isExecPathValid(path)
    items.push({
      id: `${source}|${entryName}`,
      name: entryName,
      source,
      entryName,
      command,
      path,
      pathExists: valid,
      // 任务管理器的启用位：0 表示已被禁用（界面据此把「在跑」改成「已禁用」）
      ...(approved === '0' ? { disabled: true } : {})
    })
  }

  return { items, degraded }
}

/** 采集开机自启清单（只读；注册表三个 Run 键 + 两个启动文件夹） */
export async function collectStartup(): Promise<StartupReport> {
  const started = Date.now()
  const output = await runPowerShell(PS_SCRIPT, 20000)
  const { items, degraded } = parseOutput(output)

  const bySource = {
    'registry-hkcu': 0,
    'registry-hklm': 0,
    'registry-hklm-wow': 0,
    'folder-user': 0,
    'folder-common': 0
  } satisfies Record<StartupSource, number>
  for (const item of items) bySource[item.source]++

  items.sort((a, b) => {
    const indexA = SOURCES.indexOf(a.source)
    const indexB = SOURCES.indexOf(b.source)
    if (indexA !== indexB) return indexA - indexB
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  return {
    at: Date.now(),
    items,
    // 只算「启用中且路径没了」的：禁用的项路径丢了也无害，算进去会让数字虚高
    invalid: items.filter((item) => item.disabled !== true && !item.pathExists).length,
    bySource,
    durationMs: Date.now() - started,
    degraded
  }
}
