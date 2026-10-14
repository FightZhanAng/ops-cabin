import type { StartupItem, StartupReport, StartupSource } from '../shared/startup'
import { execPathVerdict, parseExecPath } from './execpath'
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
  '# 任务管理器把「已禁用」记在 StartupApproved 下：首字节 0x03 为禁用，0x02 / 0x06 为启用。',
  '# 不读它就会把已经禁掉的自启项继续当成「每次开机都在跑」。',
  '#',
  '# 每张 StartupApproved 键**各建各的表**，不能合成一张按值名索引的总表：不同键下',
  '# 同名的值会互相覆盖（HKCU\\Run 与 HKLM\\Run、Run 与 Run32、启动文件夹与 Run 都可能',
  '# 撞名），于是某一条的启用位取自另一条 —— 界面把启用的显示成「已禁用」，或反过来。',
  '# 这也正是要把 Approved 路径挂在每个来源上的原因：查谁的表由来源决定。',
  "$apHkcuRun = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'",
  "$apHklmRun = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'",
  "$apHklmRun32 = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32'",
  "$apHkcuFolder = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'",
  "$apHklmFolder = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'",
  '# 刻意不含 HKCU\\...\\StartupApproved\\Run32：它对应的是 HKCU\\WOW6432Node\\...\\Run，',
  '# 而本采集器不枚举那张 Run 键 —— 读进来只会多一份没有归属、却能撞名的数据。',
  '$approvedKeyPaths = @($apHkcuRun, $apHklmRun, $apHklmRun32, $apHkcuFolder, $apHklmFolder)',
  '$approvedByKey = @{}',
  '',
  'function Read-Approved([string]$key) {',
  '  $map = @{}',
  '  if (Test-Path $key) {',
  '    $item = Get-Item $key -ErrorAction SilentlyContinue',
  '    if ($null -ne $item) {',
  '      foreach ($n in $item.GetValueNames()) {',
  '        if ([string]::IsNullOrEmpty($n)) { continue }',
  '        $b = $item.GetValue($n)',
  '        if ($b -is [byte[]] -and $b.Length -gt 0) { $map[$n] = ($b[0] -ne 3) }',
  '      }',
  '    }',
  '  }',
  '  return $map',
  '}',
  '',
  'function Get-ApprovedFlag([string]$key, [string]$name) {',
  '  if ($approvedByKey.ContainsKey($key)) {',
  '    $map = $approvedByKey[$key]',
  '    if ($map.ContainsKey($name)) { if ($map[$name]) { return "1" } else { return "0" } }',
  '  }',
  '  return "1"',
  '}',
  '',
  'foreach ($a in $approvedKeyPaths) { $approvedByKey[$a] = Read-Approved $a }',
  '',
  '$runKeys = @(',
  "  @{ Path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Source = 'registry-hkcu'; Approved = $apHkcuRun },",
  "  @{ Path = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Source = 'registry-hklm'; Approved = $apHklmRun },",
  "  @{ Path = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; Source = 'registry-hklm-wow'; Approved = $apHklmRun32 }",
  ')',
  'foreach ($rk in $runKeys) {',
  '  if (-not (Test-Path $rk.Path)) { continue }',
  '  $item = Get-Item $rk.Path -ErrorAction SilentlyContinue',
  '  if ($null -eq $item) { continue }',
  '  foreach ($n in $item.GetValueNames()) {',
  '    if ([string]::IsNullOrEmpty($n)) { continue }',
  '    $raw = [string]$item.GetValue($n)',
  "    $expanded = [Environment]::ExpandEnvironmentVariables($raw)",
  "    [void]$out.Add('REG' + $FS + $rk.Source + $FS + $n + $FS + $expanded + $FS + (Get-ApprovedFlag $rk.Approved $n))",
  '  }',
  '}',
  '',
  '$folders = @(',
  "  @{ Path = (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'); Source = 'folder-user'; Approved = $apHkcuFolder },",
  "  @{ Path = (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'); Source = 'folder-common'; Approved = $apHklmFolder }",
  ')',
  '# 文件夹来源要判的是「快捷方式指向的程序还在不在」，不是「.lnk 自己在不在」——',
  '# 后者刚枚举出来必然为真，等于永远判不出残留（目标程序卸载了也照旧每次都跑空）。',
  '# 读 TargetPath 是只读操作：CreateShortcut 只在 .Save() 时才写盘。',
  '# COM 建不起来（极少数受限环境）不能让整页采集跟着挂 —— 那样目标列留空，',
  '# 判据回落成 .lnk 自身路径，结论退化成改动前的行为，而不是报错。',
  '$shell = $null',
  'try { $shell = New-Object -ComObject WScript.Shell } catch { $shell = $null }',
  'foreach ($f in $folders) {',
  '  if (-not (Test-Path $f.Path)) { continue }',
  '  Get-ChildItem -LiteralPath $f.Path -File -Force -ErrorAction SilentlyContinue | ForEach-Object {',
  '    # desktop.ini 是资源管理器自己的文件夹配置（Hidden+System），不是自启项。',
  '    # -Force 会把它一起枚举出来，不排掉就会在清单里多出一条「正常」的假条目。',
  '    if ($_.Name -ieq "desktop.ini") { return }',
  "    $target = ''",
  '    if ($null -ne $shell -and $_.Extension -ieq ".lnk") {',
  '      try {',
  '        $sc = $shell.CreateShortcut($_.FullName)',
  '        $target = [string]$sc.TargetPath',
  "        if ($target.Length -gt 0) { $target = [Environment]::ExpandEnvironmentVariables($target) }",
  '      } catch { $target = "" }',
  '    }',
  "    [void]$out.Add('DIR' + $FS + $f.Source + $FS + $_.Name + $FS + $_.FullName + $FS + (Get-ApprovedFlag $f.Approved $_.Name) + $FS + $target)",
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
    const [, source, entryName, command, approved, shortcutTarget] = fields
    if (!isSource(source)) {
      degraded = true
      continue
    }
    /*
     * 判「程序还在不在」用的是：
     *   · 注册表来源 —— Run 值里的命令行；
     *   · 文件夹来源 —— 快捷方式的目标（第 6 列）。
     *
     * 文件夹来源以前直接拿 .lnk 自身路径去判，而那个文件刚被枚举出来必然存在，
     * 于是「目标程序已卸载」这个最典型的残留永远判不出来（每次都跑一次空）。
     * 目标读不到（非 .lnk、损坏、非 COM 可读）时回落成 undefined → 判不了，
     * 按「有效」处理，绝不当成失效 —— 判不了不是「不存在」。
     */
    const target =
      shortcutTarget !== undefined && shortcutTarget.trim().length > 0
        ? shortcutTarget.trim()
        : null
    const probe = target ?? command
    const path = parseExecPath(probe)
    const verdict = execPathVerdict(path)
    items.push({
      id: `${source}|${entryName}`,
      name: entryName,
      source,
      entryName,
      // command 仍是「要在界面上显示、并且删除时要动的那一份」：
      // 注册表来源是 Run 值，文件夹来源是 .lnk 的完整路径
      command,
      path,
      pathVerdict: verdict,
      // 兼容既有消费点（统计口径 / e2e 断言）：语义保持不变 ——
      // true = 路径在（或判不了，按在算），false = **确证不存在**。
      // 注意不是 `verdict === 'missing'`（那是反的）：report.invalid 依赖
      // 「!pathExists 才是失效」这个方向。
      pathExists: verdict !== 'missing',
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
