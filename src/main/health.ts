import type {
  CrashEvent,
  DiskHealth,
  HealthLog,
  HealthReport,
  LogProvider,
  ProblemDevice,
  RebootCheck
} from '../shared/health'
import { deviceLevel } from '../shared/health'
import { runPowerShell } from './powershell'

/*
 * 系统体检（只读）。
 *
 * 这一页回答的是一个散落在四五个系统工具里的问题：**这台机器整体还好吗**。
 * 故障盘、待重启、报错设备、事件日志、上次是不是没好好关机 —— 现在得分别去
 * 「优化驱动器」「Windows 更新」「设备管理器」「事件查看器」里各看一处。
 *
 * ## 为什么切成四段并发跑
 *
 * 全量串行在本机量到 11.1 秒（其中 PowerShell 进程冷启动就占 5×0.65s，
 * 设备枚举 3.7s、磁盘 1.07s、开机时刻 1.28s 各算各的）。四段之间没有任何依赖，
 * 并发跑之后墙钟取决于最慢的那一段，而不是总和。
 *
 * ## 取数路径都是量过的，不是猜的
 *
 *   · 开机时刻 → `Win32_OperatingSystem.LastBootUpTime`（权威源）。Node 的
 *     `os.uptime()` 反推在本机与它吻合到 4 秒内，但那算的是时钟运行时长，
 *     睡眠/休眠之后会偏 —— 开机时刻是「这台机器稳不稳」的基准读数，值这一次 WMI。
 *   · 磁盘 → `MSFT_PhysicalDisk`（615ms）而非 `Get-PhysicalDisk`（4.73s）。
 *     代价是只给裸数字枚举，映射表见 shared/health.ts。
 *   · 设备 → `Win32_PnPEntity`（2123ms）而非 `Get-PnpDevice -PresentOnly`（5301ms），
 *     而且**只有它排幽灵设备**：带 -PresentOnly 两边总数都是 173，不带的话
 *     `Get-PnpDevice` 是 443 —— 那 270 个 `CM_PROB_PHANTOM` 一过滤就变成
 *     271 个假警报，这一页会彻底废掉。见下面 PS_DEVICE 里的注释。
 *   · 事件日志 → `Get-WinEvent -FilterHashtable`（服务端过滤，不是取回来再 Where）。
 *
 * ## 拿不到的就说拿不到
 *
 * SMART 磨损度与温度在本机读不出来：`Get-StorageReliabilityCounter` 报
 * 「无法使用指定的命名参数解析参数集」，`MSStorageDriver_FailurePredictStatus`
 * 报「不支持」。所以这一页只给粗粒度健康档，并在界面上把这件事写出来 ——
 * 宁可少一个读数，不编一个读数。
 *
 * 字段分隔符沿用 US(0x1f) / RS(0x1e)：事件消息里有换行、路径里有冒号，
 * 控制字符在 -EncodedCommand 的 UTF-16 通道里是安全的。
 */

const FIELD = '\u001f'
const RECORD = '\u001e'

/**
 * 四段脚本共用的开头。
 *
 * `$ProgressPreference` 必须关掉：首次使用某个模块时 PowerShell 会往 stderr
 * 写 CLIXML 进度记录（「正在准备首次使用模块。」），而 runPowerShell 的调用方
 * 看到非空 stderr 会把它当成错误文本。这个坑在写探针时踩过一次。
 */
const PS_PRELUDE = [
  '$ProgressPreference = "SilentlyContinue"',
  '$FS = [char]31',
  '$RS = [char]30',
  '',
  '# 文本清洗：事件消息是整段多行文本（还带中文错误详情），不压平就会把一条拆成多条。',
  'function Clean([object]$v) {',
  '  if ($null -eq $v) { return "" }',
  "  $s = ([string]$v).Replace([char]13, ' ').Replace([char]10, ' ').Replace([char]9, ' ')",
  '  $s = $s.Replace([char]31, " ").Replace([char]30, " ")',
  '  return $s.Trim()',
  '}',
  '',
  'function Cut([object]$v, [int]$max) {',
  '  $s = Clean $v',
  '  if ($s.Length -gt $max) { $s = $s.Substring(0, $max) }',
  '  return $s',
  '}'
].join('\n')

function ps(script: string): string {
  return `${PS_PRELUDE}\n\n${script}`
}

/* ------------------------------------------------------------ 段 1：开机与待重启 */

const PS_BOOT = [
  '$out = New-Object System.Collections.ArrayList',
  '',
  '# 开机时刻：权威源，见文件头的说明。',
  '$boot = \'\'',
  'try {',
  '  $os = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -ErrorAction Stop',
  '  if ($null -ne $os.LastBootUpTime) {',
  '    $boot = [string]([DateTimeOffset]::new($os.LastBootUpTime).ToUnixTimeMilliseconds())',
  '  }',
  '} catch { }',
  '',
  '# 两处「必须重启」标记：Windows 自己写的，键在就是要重启。',
  '# 分开报而不是合成一个布尔 —— 用户该看到的是「哪件事在等重启」。',
  '$cbs = 0',
  "try { if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') { $cbs = 1 } } catch { }",
  '$wu = 0',
  "try { if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { $wu = 1 } } catch { }",
  '',
  '# 待处理的文件改名/删除队列。登记格式是 [源, 目标] 成对出现，目标为空串表示删除。',
  '# 只报「几个槽位、几个不同文件」+ 路径明细，含义见 shared/health.ts 的 REBOOT_SOURCE_NOTE。',
  '$slots = 0',
  '$seen = @{}',
  'try {',
  "  $props = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -ErrorAction SilentlyContinue",
  '  foreach ($entry in @($props.PendingFileRenameOperations)) {',
  '    $text = Cut $entry 400',
  '    if ($text.Length -eq 0) { continue }',
  '    $slots++',
  '    # 前缀形如 *1\\??\\ （删除）或 *2\\??\\ （替换），去掉它才是真路径',
  "    $path = $text -replace '^\\*[0-9]+\\\\\\?\\?\\\\', ''",
  '    $key = $path.ToLowerInvariant()',
  '    if (-not $seen.ContainsKey($key)) {',
  '      $seen[$key] = $true',
  '      # 明细单独成一条记录：路径里什么都可能有，塞进字段里用分隔符拼会有歧义',
  "      [void]$out.Add((@('F', $path) -join $FS))",
  '    }',
  '  }',
  '} catch { }',
  '',
  "$row = @('B', $boot, [string]$cbs, [string]$wu, [string]$slots, [string]$seen.Count)",
  '[void]$out.Add($row -join $FS)',
  '',
  '$out -join $RS'
].join('\n')

/* ------------------------------------------------------------ 段 2：磁盘 */

const PS_DISK = [
  '# 磁盘号统一成字符串键。定义必须放在使用之前 —— PowerShell 按文本顺序执行，',
  '# 放到 $sys 那一段后面会直接报「无法将 Key 识别为 cmdlet」。',
  'function Key([object]$v) {',
  '  try { return [string][int]$v } catch { return "" }',
  '}',
  '',
  '$out = New-Object System.Collections.ArrayList',
  '',
  '# MSFT_PhysicalDisk 走 CIM 直查（本机 615ms），Get-PhysicalDisk 要 4.73s：',
  '# cmdlet 那一圈还要做对象投影与格式化。代价是只给裸数字枚举，映射见 shared/health.ts。',
  '$disks = @()',
  'try {',
  '  $disks = @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk -ErrorAction SilentlyContinue)',
  '} catch { }',
  '',
  '# 系统盘标记：MSFT_Disk.IsSystem / IsBoot 按磁盘号对齐（MSFT_PhysicalDisk.DeviceId 就是磁盘号）。',
  '# 单独一条查询，失败了只是少一个「系统盘」标记，不影响健康档。',
  '$sys = @{}',
  'try {',
  '  foreach ($d in @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_Disk -ErrorAction SilentlyContinue)) {',
  '    if (($d.IsSystem -eq $true) -or ($d.IsBoot -eq $true)) { $sys[(Key $d.Number)] = $true }',
  '  }',
  '} catch { }',
  '',
  'foreach ($d in $disks) {',
  '  $ops = @()',
  '  try { foreach ($o in @($d.OperationalStatus)) { if ($null -ne $o) { $ops += [string][int]$o } } } catch { }',
  '  # 读不到就留空，绝不填哨兵值：填 0 会被解码成「健康」，等于凭一个没读到的数字说好话。',
  "  $health = ''",
  "  $media = ''",
  "  $bus = ''",
  "  $size = ''",
  '  try { if ($null -ne $d.HealthStatus) { $health = [string][int]$d.HealthStatus } } catch { }',
  '  try { if ($null -ne $d.MediaType) { $media = [string][int]$d.MediaType } } catch { }',
  '  try { if ($null -ne $d.BusType) { $bus = [string][int]$d.BusType } } catch { }',
  '  try { if ($null -ne $d.Size) { $size = [string][long]$d.Size } } catch { }',
  "  $isSys = '0'",
  '  if ($sys.ContainsKey((Key $d.DeviceId))) { $isSys = \'1\' }',
  '  $row = @(\'D\', (Key $d.DeviceId), (Cut $d.FriendlyName 120), $health, $media, $bus, $size, ($ops -join \',\'), $isSys)',
  '  [void]$out.Add($row -join $FS)',
  '}',
  '',
  '# 一块盘都读不到在 Windows 上几乎不可能 —— 不显式说出来的话界面会显示「0 块盘，一切正常」。',
  "[void]$out.Add((@('H', [string]$disks.Count) -join $FS))",
  '',
  '$out -join $RS'
].join('\n')

/* ------------------------------------------------------------ 段 3：设备 */

const PS_DEVICE = [
  '$out = New-Object System.Collections.ArrayList',
  '',
  '# Win32_PnPEntity 只枚举**在位**设备，比 Get-PnpDevice 又快又对。',
  '#',
  '# 本机实测（这是这一页最要紧的一条）：',
  '#   Win32_PnPEntity 总数                 173',
  '#   Get-PnpDevice -PresentOnly 总数      173   ← 两者一致',
  '#   Get-PnpDevice 总数                   443   ← 多出来的 270 个全是 CM_PROB_PHANTOM',
  '#   Get-PnpDevice 里 Problem <> 0        271   ← 幽灵设备，一过滤就全变成「问题设备」',
  '#',
  '# 那 270 个是驱动仓库里的历史残留：拔掉的罗技鼠标、用过的 USB 硬盘盒、外接显示器……',
  '# 按 Problem <> 0 报，这一页会给出 271 个假警报。耗时同样占优：',
  '# 带过滤的 CIM 查询 2123ms vs Get-PnpDevice -PresentOnly 5301ms。',
  '$list = @()',
  'try {',
  '  $list = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "ConfigManagerErrorCode <> 0" -ErrorAction SilentlyContinue)',
  '} catch { }',
  '',
  'foreach ($x in $list) {',
  '  # 从 CimInstanceProperties 里取裸值，不走属性访问器：PnpDevice 模块一旦加载，',
  '  # ConfigManagerErrorCode 会被渲染成枚举符号名（本机是 CM_PROB_DISABLED），',
  '  # 而这里要的是数字。读不到就留 0 —— 过滤条件保证 <> 0，上层看到 0 就知道这条没读全。',
  '  $code = 0',
  "  try { $code = [int]$x.PSBase.CimInstanceProperties['ConfigManagerErrorCode'].Value } catch { }",
  "  $row = @('P', (Cut $x.Name 160), (Cut $x.PNPClass 60), (Cut $x.Status 40), [string]$code)",
  '  [void]$out.Add($row -join $FS)',
  '}',
  '',
  "[void]$out.Add((@('H', [string]$list.Count) -join $FS))",
  '',
  '$out -join $RS'
].join('\n')

/* ------------------------------------------------------------ 段 4：事件日志与意外关机 */

/** 单个日志的采集上限：一台刷屏的机器能在 7 天里堆出几十万条 */
const LOG_CAP = 1000

const PS_EVENTS = [
  '$out = New-Object System.Collections.ArrayList',
  '',
  'function EmitLog([string]$log, [int]$days) {',
  '  $since = (Get-Date).AddDays(-$days)',
  '  $evts = @()',
  '  try {',
  `    $evts = @(Get-WinEvent -FilterHashtable @{LogName=$log; Level=1,2; StartTime=$since} -MaxEvents ${LOG_CAP} -ErrorAction SilentlyContinue)`,
  '  } catch { }',
  "  $trunc = '0'",
  `  if ($evts.Count -ge ${LOG_CAP}) { $trunc = '1' }`,
  "  [void]$out.Add((@('L', $log, [string]$days, [string]$evts.Count, $trunc) -join $FS))",
  '  # 按来源聚合：同一个来源反复报，比「到处都在报」更容易定位。',
  '  try {',
  '    foreach ($g in @($evts | Group-Object ProviderName | Sort-Object Count -Descending)) {',
  '      $last = @($g.Group | Sort-Object TimeCreated -Descending)[0]',
  "      $ms = ''",
  '      try { $ms = [string]([DateTimeOffset]::new($last.TimeCreated).ToUnixTimeMilliseconds()) } catch { }',
  "      $row = @('P', $log, (Cut $g.Name 120), [string]$g.Count, $ms, [string]$last.Id, (Cut $last.Message 220))",
  '      [void]$out.Add($row -join $FS)',
  '    }',
  '  } catch { }',
  '}',
  '',
  '# 只取严重与错误两档（Level 1 = Critical、2 = Error）。Warning 在本机 7 天就有几百条，',
  '# 混进来只会把真问题埋掉 —— 这一页要的是「哪里在报错」，不是「所有通知」。',
  "EmitLog 'System' 7",
  "EmitLog 'Application' 7",
  '',
  '# 意外关机单独一段，窗口放到 30 天：Kernel-Power 41 是「没有干净关机」，',
  '# EventLog 6008 是「上次关机是意外的」。这两条不是「错误」，而是「上次为什么那样关的」——',
  '# 7 天窗口大概率什么都看不到，而用户来翻这一页时想问的往往正是这件事。',
  '$WIN = 30',
  '$crash = @()',
  'try {',
  "  $crash = @(Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,6008; StartTime=(Get-Date).AddDays(-$WIN)} -MaxEvents 200 -ErrorAction SilentlyContinue)",
  '} catch { }',
  'foreach ($e in @($crash | Sort-Object TimeCreated -Descending)) {',
  "  $ms = ''",
  '  try { $ms = [string]([DateTimeOffset]::new($e.TimeCreated).ToUnixTimeMilliseconds()) } catch { }',
  "  $row = @('C', (Cut $e.ProviderName 80), [string]$e.Id, $ms, (Cut $e.Message 260))",
  '  [void]$out.Add($row -join $FS)',
  '}',
  '',
  "[void]$out.Add((@('H', [string]$WIN, [string]$crash.Count) -join $FS))",
  '',
  '$out -join $RS'
].join('\n')

/* ------------------------------------------------------------ 解析 */

/** 空字符串 = 「没有这个数」，不是 0 —— `Number('')` 是 0，所以必须先挡住 */
function parseNumber(text: string): number | null {
  if (text.length === 0) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function rows(output: string): string[][] {
  const list: string[][] = []
  for (const record of output.split(RECORD)) {
    const text = record.trim()
    if (text.length === 0) continue
    list.push(text.split(FIELD))
  }
  return list
}

interface ParsedBoot {
  bootedAt: number | null
  reboot: RebootCheck[]
}

function parseBoot(output: string): ParsedBoot | null {
  let bootedAt: number | null = null
  let cbs: number | null = null
  let wu: number | null = null
  let slots: number | null = null
  let distinct: number | null = null
  const paths: string[] = []
  let seen = false

  for (const fields of rows(output)) {
    const tag = fields[0]
    if (tag === 'F') {
      if (fields.length >= 2 && paths.length < 20) paths.push(fields[1])
      continue
    }
    if (tag !== 'B' || fields.length < 6) continue
    seen = true
    bootedAt = parseNumber(fields[1])
    cbs = parseNumber(fields[2])
    wu = parseNumber(fields[3])
    slots = parseNumber(fields[4])
    distinct = parseNumber(fields[5])
  }
  if (!seen) return null

  const reboot: RebootCheck[] = [
    {
      source: 'cbs',
      level: cbs === 1 ? 'required' : 'clear',
      detail: cbs === 1 ? '有一个组件更新要重启才能收尾' : null,
      paths: []
    },
    {
      source: 'windows-update',
      level: wu === 1 ? 'required' : 'clear',
      detail: wu === 1 ? 'Windows 更新在等一次重启' : null,
      paths: []
    },
    {
      source: 'file-rename',
      /*
       * 这一项**永远**是 advisory，见 shared/health.ts 的说明：
       * 本机 24 个槽位里同一文件被登记了 3 次，那是应用自己排的
       * 「下次开机顺手删」队列，不是系统要求重启。
       */
      level: distinct !== null && distinct > 0 ? 'advisory' : 'clear',
      detail:
        distinct !== null && distinct > 0
          ? `${distinct} 个文件排队${
              slots !== null && slots > distinct ? `（${slots} 条登记，有重复）` : ''
            }`
          : null,
      paths
    }
  ]

  return { bootedAt, reboot }
}

function parseDisks(output: string): { disks: DiskHealth[]; scanned: number } | null {
  const disks: DiskHealth[] = []
  let scanned: number | null = null

  for (const fields of rows(output)) {
    const tag = fields[0]
    if (tag === 'H') {
      scanned = parseNumber(fields[1] ?? '') ?? 0
      continue
    }
    if (tag !== 'D' || fields.length < 9) continue
    const [, deviceId, name, health, media, bus, size, ops, isSys] = fields
    const operational: number[] = []
    for (const token of ops.length > 0 ? ops.split(',') : []) {
      const code = parseNumber(token)
      if (code !== null) operational.push(code)
    }
    disks.push({
      name: name.length > 0 ? name : `磁盘 ${deviceId}`,
      healthRaw: parseNumber(health),
      mediaRaw: parseNumber(media),
      busRaw: parseNumber(bus),
      operationalRaw: operational,
      sizeBytes: parseNumber(size),
      system: isSys === '1'
    })
  }

  if (scanned === null) return null
  return { disks, scanned }
}

function parseDevices(output: string): { devices: ProblemDevice[]; scanned: number } | null {
  const devices: ProblemDevice[] = []
  let scanned: number | null = null

  for (const fields of rows(output)) {
    const tag = fields[0]
    if (tag === 'H') {
      scanned = parseNumber(fields[1] ?? '') ?? 0
      continue
    }
    if (tag !== 'P' || fields.length < 5) continue
    const [, name, pnpClass, status, codeText] = fields
    const code = parseNumber(codeText)
    // 0 表示这一条的错误码没读出来（WMI 过滤条件保证 <> 0）—— 宁可少列一条，
    // 不拿一个读不到的数字去分档。
    if (code === null || code === 0 || name.length === 0) continue
    devices.push({
      name,
      pnpClass: pnpClass.length > 0 ? pnpClass : '未知类型',
      code,
      status: status.length > 0 ? status : '未知状态'
    })
  }

  if (scanned === null) return null
  return { devices, scanned }
}

interface ParsedEvents {
  logs: HealthLog[]
  crashes: CrashEvent[]
  crashWindowDays: number
}

function parseEvents(output: string): ParsedEvents | null {
  const logs = new Map<string, HealthLog>()
  const crashes: CrashEvent[] = []
  let crashWindowDays: number | null = null
  let seen = false

  for (const fields of rows(output)) {
    const tag = fields[0]

    if (tag === 'L' && fields.length >= 5) {
      seen = true
      const [, logName, windowText, totalText, truncText] = fields
      logs.set(logName, {
        logName,
        windowDays: parseNumber(windowText) ?? 0,
        total: parseNumber(totalText) ?? 0,
        truncated: truncText === '1',
        providers: []
      })
      continue
    }

    if (tag === 'P' && fields.length >= 7) {
      const [, logName, name, countText, lastAtText, lastIdText, sample] = fields
      const log = logs.get(logName)
      if (!log) continue
      const provider: LogProvider = {
        name,
        count: parseNumber(countText) ?? 0,
        lastAt: parseNumber(lastAtText),
        lastId: parseNumber(lastIdText),
        sample: sample.length > 0 ? sample : null
      }
      log.providers.push(provider)
      continue
    }

    if (tag === 'C' && fields.length >= 5) {
      const [, source, idText, atText, message] = fields
      const at = parseNumber(atText)
      const id = parseNumber(idText)
      if (at === null || id === null) continue
      crashes.push({ at, source, id, message })
      continue
    }

    if (tag === 'H' && fields.length >= 3) {
      seen = true
      crashWindowDays = parseNumber(fields[1])
    }
  }

  if (!seen) return null

  // 同一来源在一个窗口里报几百条时，把「最近一条」的消息和一个样本一起交出去，
  // 比只给条数有用得多。排序在 TS 侧重做一遍，不依赖 PowerShell 的输出顺序。
  for (const log of logs.values()) {
    log.providers.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'))
  }

  crashes.sort((a, b) => b.at - a.at)
  return { logs: [...logs.values()], crashes, crashWindowDays: crashWindowDays ?? 0 }
}

/* ------------------------------------------------------------ 采集 */

/** 把某一分支的失败变成一句人话（用户看到的是「哪一块没读到」，不是堆栈） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 采集系统体检（只读；四段并发） */
export async function collectHealth(): Promise<HealthReport> {
  const started = Date.now()

  const [bootResult, diskResult, deviceResult, eventResult] = await Promise.allSettled([
    runPowerShell(ps(PS_BOOT), 30_000),
    runPowerShell(ps(PS_DISK), 30_000),
    runPowerShell(ps(PS_DEVICE), 30_000),
    runPowerShell(ps(PS_EVENTS), 45_000)
  ])

  const problems: string[] = []

  const boot = bootResult.status === 'fulfilled' ? parseBoot(bootResult.value) : null
  if (boot === null) {
    problems.push(bootResult.status === 'rejected' ? `开机与重启标记：${reason(bootResult.reason)}` : '开机与重启标记：返回内容无法解析')
  }

  const disks = diskResult.status === 'fulfilled' ? parseDisks(diskResult.value) : null
  if (disks === null) {
    problems.push(diskResult.status === 'rejected' ? `磁盘：${reason(diskResult.reason)}` : '磁盘：返回内容无法解析')
  } else if (disks.scanned === 0) {
    // 一块盘都读不到在 Windows 上几乎不可能 —— 那是查询失败，不是机器没硬盘。
    problems.push('磁盘：一块盘都没读到，物理磁盘查询可能失败')
  }

  const devices = deviceResult.status === 'fulfilled' ? parseDevices(deviceResult.value) : null
  if (devices === null) {
    problems.push(deviceResult.status === 'rejected' ? `设备：${reason(deviceResult.reason)}` : '设备：返回内容无法解析')
  }

  const events = eventResult.status === 'fulfilled' ? parseEvents(eventResult.value) : null
  if (events === null) {
    problems.push(eventResult.status === 'rejected' ? `事件日志：${reason(eventResult.reason)}` : '事件日志：返回内容无法解析')
  }

  const reboot = boot?.reboot ?? []
  const deviceList = devices?.devices ?? []

  return {
    at: Date.now(),
    durationMs: Date.now() - started,
    bootedAt: boot?.bootedAt ?? null,
    // 开机时长由采集器统一算：界面拿 Unix 毫秒自己减会在跨时区/时钟调整时对不上，
    // 而且「读于」那一栏也是同一个时刻，两处各算一次必然有偏差。
    uptimeMs: boot?.bootedAt != null ? Math.max(0, Date.now() - boot.bootedAt) : null,
    reboot,
    // 只有 required 算「要求重启」—— file-rename 那档是提示，见 shared/health.ts
    rebootRequired: reboot.filter((item) => item.level === 'required').length,
    logs: events?.logs ?? [],
    crashes: events?.crashes ?? [],
    crashWindowDays: events?.crashWindowDays ?? 0,
    disks: disks?.disks ?? [],
    devices: deviceList,
    deviceProblems: deviceList.filter((item) => deviceLevel(item.code) === 'problem').length,
    deviceDisabled: deviceList.filter((item) => deviceLevel(item.code) === 'disabled').length,
    degraded: problems.length > 0,
    ...(problems.length > 0 ? { error: problems.join('；') } : {})
  }
}
