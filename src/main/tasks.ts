import type { TaskItem, TaskReport, TaskResult, TaskState, TaskTrigger } from '../shared/tasks'
import { decodeTaskResult } from '../shared/tasks'
import { isExecPathValid, parseExecPath } from './execpath'
import { runPowerShell } from './powershell'

/*
 * 计划任务清单（只读）。
 *
 * 为什么值得单独看：开机自启只覆盖三个 Run 键 + 两个启动文件夹，而真正在后台偷跑的
 * 大头在任务计划程序里 —— 遥测上报、自动更新、定时联网。本机 180 个任务里有 17 个
 * 不是微软自带的，正好就是「谁在定时联网」这个问题的答案。
 *
 * 为什么走 COM（`Schedule.Service`）而不是 `Get-ScheduledTask`：
 * 本机实测 cmdlet 要 3.7 秒、COM 只要 1.5 秒 —— `Get-ScheduledTask` 是逐任务走一次
 * WMI 往返，180 个任务就是 180 次。`Get-ScheduledTaskInfo` 另算。COM 一次枚举就
 * 把状态、上次/下次运行时间、结果码、触发器、动作全拿到了。
 * 代价是枚举值是裸整数，下面那张映射表在**本机全部 180 个任务**上与 cmdlet 的
 * CIM 类名逐条对齐过（每个整数只对应一个类名），不是照文档抄的。
 *
 * 两个已经踩过的坑写在代码里，不重犯：
 *   1. `LastTaskResult` 不能按 `!= 0` 判失败（见 shared/tasks.ts 的 decodeTaskResult）；
 *   2. 「已禁用」不是异常 —— 服务、自启项、设备之后第四次遇到同一条纪律。
 *
 * 字段分隔符沿用 US(0x1f) / RS(0x1e)：任务参数里完全可能出现 `|` 和换行，
 * 控制字符在 -EncodedCommand 的 UTF-16 通道里则是安全的。
 */

const FIELD = '\u001f'
const RECORD = '\u001e'

const PS_SCRIPT = [
  '$FS = [char]31',
  '$RS = [char]30',
  '',
  '# 文本清洗：任务名/作者/参数里可能有换行或制表符，混进记录就会把一条拆成两条。',
  'function Clean([object]$v) {',
  '  if ($null -eq $v) { return "" }',
  "  $s = ([string]$v).Replace([char]13, ' ').Replace([char]10, ' ').Replace([char]9, ' ')",
  '  $s = $s.Replace([char]31, " ").Replace([char]30, " ")',
  '  return $s.Trim()',
  '}',
  '',
  '# 时间统一转成 Unix 毫秒，不给下游留时区解释的余地：',
  '#   · 「从未运行」的任务 LastRunTime 是 1900-01-01，按「没有」处理；',
  '#   · Kind 为 Utc 的先转本地再算。',
  'function ToMs([object]$dt) {',
  '  if ($null -eq $dt) { return "" }',
  '  try {',
  '    $d = [datetime]$dt',
  '    if ($d.Year -le 1900) { return "" }',
  '    if ($d.Kind -eq [System.DateTimeKind]::Utc) { $d = $d.ToLocalTime() }',
  '    return [string]([DateTimeOffset]::new($d).ToUnixTimeMilliseconds())',
  '  } catch { return "" }',
  '}',
  '',
  '# 递归枚举任务。GetTasks(1) 的 1 = 含隐藏任务，GetFolders(1) 同理 ——',
  '# 不带这个标志会漏掉一批，而「漏掉一条」比「多列一条」更糟。',
  'function Walk($f, $acc) {',
  '  foreach ($x in $f.GetTasks(1)) { [void]$acc.Add($x) }',
  '  foreach ($s in $f.GetFolders(1)) { Walk $s $acc }',
  '}',
  '',
  '$err = ""',
  '$ok = $false',
  'try {',
  '  $svc = New-Object -ComObject Schedule.Service',
  '  $svc.Connect()',
  '  $ok = $true',
  '} catch {',
  '  $err = Clean $_.Exception.Message',
  '}',
  '',
  '$out = New-Object System.Collections.ArrayList',
  '$scanned = 0',
  '$skipped = 0',
  '',
  'if ($ok) {',
  '  $acc = New-Object System.Collections.ArrayList',
  '  Walk $svc.GetFolder("\\") $acc',
  '  $scanned = $acc.Count',
  '',
  '  foreach ($x in $acc) {',
  '    $path = Clean $x.Path',
  "    # \\Microsoft\\* 是系统自带的一整片（本机 180 个里占 163 个），全列会把用户自己装的十几个埋掉。",
  "    if ($path -like '\\Microsoft\\*') { $skipped++; continue }",
  '    $name = Clean $x.Name',
  '',
  '    # Definition 是懒加载的，只有这几个非微软任务才会真正去读 —— 全读会多花一倍时间。',
  '    # 读不到（权限/损坏）时整个留空，上层按「不知道」处理，不判路径、不报故障。',
  "    $author = ''",
  '    try { $author = Clean $x.Definition.RegistrationInfo.Author } catch { }',
  '    if ($author.Length -gt 160) { $author = $author.Substring(0, 160) }',
  '',
  "    $state = ''",
  '    try { $state = Clean $x.State } catch { }',
  '',
  '# Enabled 与 State 说的是同一件事（1 = 已禁用），但 Enabled 是布尔值，不依赖枚举编号 ——',
  '# 判「有没有被禁用」用它比用 State 稳。',
  "    $enabled = '1'",
  '    try { if (-not $x.Enabled) { $enabled = "0" } } catch { }',
  '',
  "    $tg = @()",
  '    try { foreach ($t in $x.Definition.Triggers) { $tg += [string]$t.Type } } catch { $tg += "ERR" }',
  '',
  "    $actionType = ''",
  "    $exec = ''",
  "    $execArgs = ''",
  '    try {',
  '      $acts = @($x.Definition.Actions)',
  '      if ($acts.Count -gt 0) {',
  '        $actionType = [string]$acts[0].Type',
  '        foreach ($a in $acts) {',
  '          if ([string]$a.Type -eq "0") {',
  '# Path 要展开环境变量：本机 DataSenseLiveTileTask 写的就是 %SystemRoot%\\System32\\...，',
  '# 不展开就没法判存在性，会把一个好好的任务说成「路径失效」。',
  '            $exec = Clean ([Environment]::ExpandEnvironmentVariables([string]$a.Path))',
  '            $execArgs = Clean $a.Arguments',
  '            $actionType = "0"',
  '            break',
  '          }',
  '        }',
  '      }',
  '    } catch { $actionType = "ERR" }',
  '    if ($execArgs.Length -gt 300) { $execArgs = $execArgs.Substring(0, 300) }',
  '',
  '# 运行信息。取不到就整个留空 —— 绝不能填哨兵值（例如 -1）：上层会把 -1 归一化成',
  '# 0xFFFFFFFF，而它解码出来是「失败」，等于凭一个读不到的数字报假故障。',
  "    $lastRun = ''",
  "    $nextRun = ''",
  "    $lastResult = ''",
  '    try { $lastRun = ToMs $x.LastRunTime } catch { }',
  '    try { $nextRun = ToMs $x.NextRunTime } catch { }',
  '    try { $lastResult = [string]([long]$x.LastTaskResult) } catch { }',
  '',
  "    $row = @('T', $path, $name, $author, $state, $enabled, ($tg -join ','), $actionType, $exec, $execArgs, $lastRun, $nextRun, $lastResult)",
  '    [void]$out.Add($row -join $FS)',
  '  }',
  '}',
  '',
  '# 汇总记录放最后：总数与跳过数只有跑完才知道。',
  '# 写成一条记录而不是单独几行，parseOutput 就只需要一个循环、一种形态。',
  "$row = @('H', [string]$scanned, [string]$skipped, $err)",
  '[void]$out.Add($row -join $FS)',
  '',
  '$out -join $RS'
].join('\n')

/**
 * COM `ITrigger.Type` → 触发类型。
 *
 * 这张表在**本机全部 180 个任务**上与 cmdlet 的 `CimClass.CimClassName` 逐条对齐过，
 * 每个整数只对应一个类名，没有歧义：
 *   0→Event 1→Time 2→Daily 3→Weekly 6→Idle 7→Registration 8→Boot 9→Logon
 *   11→SessionStateChange 12→`MSFT_TaskTrigger`（基类，即自定义触发器）
 * 4(每月) / 5(每月第几个星期几) 本机没有任务用到，是按上面这条连续序列补的。
 * 12 落到基类上 —— 这正是不认识的触发器该有的样子，归 other 并在行上留记号。
 */
export function mapTriggerType(code: number): TaskTrigger {
  const TABLE: Record<number, TaskTrigger> = {
    0: 'event',
    1: 'time',
    2: 'daily',
    3: 'weekly',
    4: 'monthly',
    5: 'monthly',
    6: 'idle',
    7: 'registration',
    8: 'boot',
    9: 'logon',
    11: 'session'
  }
  return TABLE[code] ?? 'other'
}

/** COM `IAction.Type`：本机实测 0 = 执行程序、5 = COM 处理程序 */
const ACTION_EXEC = 0

/** 正在运行时的 `IRegisteredTask.State`（本机实测：正在运行 = 4） */
const STATE_RUNNING = 4

/** 空字符串 = 「没有这个数」，不是 0 —— `Number('')` 是 0，所以必须先挡住 */
function parseNumber(text: string): number | null {
  if (text.length === 0) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/**
 * 一行的状态。
 *
 * 顺序不能换：已禁用的任务根本不会运行，路径没了、上次结果难看都不该算成问题 ——
 * 把禁用的项并进「失败」会让用户去修一个本来就没在跑的东西。
 * 这个顺序与 report.attention 的口径绑死（同样先短路 disabled），改一边就要改另一边。
 */
function resolveState(
  disabled: boolean,
  pathExists: boolean,
  result: TaskResult | null
): TaskState {
  if (disabled) return 'disabled'
  if (!pathExists) return 'missing'
  if (result !== null && !result.ok) return 'failing'
  return 'ok'
}

interface ParsedTasks {
  items: TaskItem[]
  scanned: number
  systemSkipped: number
  degraded: boolean
  error?: string
}

function parseOutput(output: string): ParsedTasks {
  const items: TaskItem[] = []
  let degraded = false
  let scanned = 0
  let systemSkipped = 0
  let error: string | undefined

  for (const record of output.split(RECORD)) {
    const text = record.trim()
    if (text.length === 0) continue
    const fields = text.split(FIELD)
    const tag = fields[0]

    if (tag === 'H') {
      if (fields.length < 4) {
        degraded = true
        continue
      }
      const total = Number(fields[1])
      const skip = Number(fields[2])
      scanned = Number.isFinite(total) ? total : 0
      systemSkipped = Number.isFinite(skip) ? skip : 0
      const message = (fields[3] ?? '').trim()
      if (message.length > 0) {
        error = message
        degraded = true
      }
      continue
    }

    if (tag !== 'T' || fields.length < 13) {
      degraded = true
      continue
    }

    const [
      ,
      path,
      name,
      author,
      rawState,
      rawEnabled,
      triggerText,
      actionType,
      exec,
      args,
      lastRunText,
      nextRunText,
      resultText
    ] = fields

    if (name.length === 0 || path.length === 0) {
      degraded = true
      continue
    }

    const triggers: TaskTrigger[] = []
    let hasUnknownTrigger = false
    if (triggerText.length > 0) {
      for (const token of triggerText.split(',')) {
        const code = parseNumber(token)
        const trigger = code === null ? 'other' : mapTriggerType(code)
        if (trigger === 'other') hasUnknownTrigger = true
        if (!triggers.includes(trigger)) triggers.push(trigger)
      }
    }

    // 只有「执行程序」类动作才判路径：COM 处理程序没有可判的路径，
    // 那种情况按「有效」处理，否则会凭一个拿不到的路径报假故障。
    // exec 走 parseExecPath 是必须的 —— 有的安装程序把引号写进了任务 XML 的
    // <Command> 里（本机 WPS、Snipaste 都是），直接 existsSync 会 100% 误报失效。
    //
    // isExecPathValid 现在是三态判定的布尔投影：**只有确证不存在才是 false**
    // （ENOENT / ENOTDIR）。解析不出路径、裸命令名、指向目录、EPERM 读不到一律为
    // true —— 这些「判不了」的情况以前会被判成 missing，从而给出删除入口。
    const hasExec = parseNumber(actionType) === ACTION_EXEC && exec.length > 0
    const execPath = hasExec ? parseExecPath(exec) : null
    const pathExists = hasExec ? isExecPathValid(execPath) : true

    const resultValue = parseNumber(resultText)
    const lastResult = resultValue === null ? null : decodeTaskResult(resultValue)

    const stateCode = parseNumber(rawState)
    // 已禁用只看 Enabled（布尔），不看 State 的整数编号
    const disabled = rawEnabled === '0'
    // 路径是「文件夹 + 名字」：COM 只给全路径，文件夹靠名字长度反推
    const folder = path.endsWith(name) ? path.slice(0, path.length - name.length) : '\\'

    items.push({
      id: path,
      name,
      folder: folder.length > 0 ? folder : '\\',
      state: resolveState(disabled, pathExists, lastResult),
      // 正在运行与状态档无关：一个 Ready 的任务此刻也可能正好在跑
      running: stateCode === STATE_RUNNING,
      triggers,
      hasUnknownTrigger,
      lastRunAt: parseNumber(lastRunText),
      nextRunAt: parseNumber(nextRunText),
      lastResult,
      action: hasExec ? (args.length > 0 ? `${exec} ${args}` : exec) : null,
      pathExists,
      author: author.length > 0 ? author : null
    })
  }

  // 一个任务都读不到，在 Windows 上是不可能的 —— 那是枚举失败，不是机器干净。
  // 不显式说出来的话界面会显示「0 个任务，一切正常」。
  if (error === undefined && scanned === 0) {
    error = '没有读到任何计划任务 —— 任务计划程序枚举可能失败'
    degraded = true
  }

  return { items, scanned, systemSkipped, degraded, ...(error !== undefined ? { error } : {}) }
}

/** 采集计划任务清单（只读；跳过 `\Microsoft\*` 的系统任务） */
export async function collectTasks(): Promise<TaskReport> {
  const started = Date.now()
  const output = await runPowerShell(PS_SCRIPT, 30000)
  const { items, scanned, systemSkipped, degraded, error } = parseOutput(output)

  items.sort((a, b) => {
    // 根目录的排最前 —— 用户自己装的任务绝大多数在根目录，系统带的喜欢往子文件夹塞
    const rankA = a.folder === '\\' ? 0 : 1
    const rankB = b.folder === '\\' ? 0 : 1
    if (rankA !== rankB) return rankA - rankB
    if (a.folder !== b.folder) return a.folder.localeCompare(b.folder, 'zh-Hans-CN')
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  return {
    at: Date.now(),
    items,
    scanned,
    systemSkipped,
    // 与行上的灯同一套判据：只算「启用中且（可执行文件不在 或 上次运行失败）」的
    attention: items.filter((item) => item.state === 'failing' || item.state === 'missing').length,
    enabled: items.filter((item) => item.state !== 'disabled').length,
    durationMs: Date.now() - started,
    degraded,
    ...(error !== undefined ? { error } : {})
  }
}
