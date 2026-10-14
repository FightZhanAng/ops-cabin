import type { ServiceCandidate, ServiceRunState, ServiceStatus } from '../../shared/services'
import { runPowerShell } from '../powershell'

/*
 * Windows 服务采集（只读）。
 *
 * 走 Win32_Service 的 WQL 过滤而不是 `Get-Service -Name a,b,c`：后者拿不到启动
 * 类型（Auto / Manual / Disabled）与二进制路径，而那两样恰恰是判断「这个服务
 * 该不该在跑」的依据 —— 一个 Disabled 的服务停着是正常的，不该亮灯。
 *
 * 过滤条件在单次调用里拼成 `Name='a' OR Name='b'`，避免按名逐个起 PowerShell
 * （每起一次冷启动 1–2 秒，关注 5 个服务就是 10 秒）。
 */

const FIELD = '\u001f'
const RECORD = '\u001e'

/**
 * 服务名**作为数据**传进脚本，而不是拼进脚本文本。
 *
 * 早前是拼好 WQL 字面量再塞进 `$filter = "..."` 这个 PowerShell 双引号字符串：
 * 转义只做了 WQL 那一层（单引号翻倍），管不到 PowerShell 的变量展开与反引号转义。
 * 于是 `MSSQL$SQLEXPRESS`（SQL Server 命名实例的标准服务名，候选列表里能正常
 * 选到）被解析成 `Name='MSSQL'` —— 查不到，界面永久显示「不在了」；名字里带
 * 双引号时引号提前闭合，注入片段会成为独立语句。
 *
 * 现在把名字数组 base64(UTF-8) 传进去，在脚本内部解码后自建 WQL：脚本源码里
 * 不含任何用户数据，PowerShell 的解析层无从被破坏。
 */
function encodeNames(names: readonly string[]): string {
  return Buffer.from(JSON.stringify(names), 'utf8').toString('base64')
}

function mapState(raw: string): ServiceRunState {
  const text = raw.trim().toLowerCase()
  if (text === 'running') return 'running'
  if (text === 'stopped') return 'stopped'
  if (text.includes('pending') || text === 'paused' || text.includes('pause')) return 'pending'
  return 'unknown'
}

/**
 * 构建采集脚本；`names` 为空数组表示「全量查询」（添加对话框取候选时用）。
 *
 * 注意这里是**字符串数组**而不是模板串拼脚本：脚本内容全部是常量，唯一的动态
 * 数据（服务名）只经 base64 进来。改动这个函数时请保持这条性质。
 */
function emitScript(names: readonly string[]): string {
  return [
    '$FS = [char]31',
    '$RS = [char]30',
    '$out = New-Object System.Collections.ArrayList',
    // 动态数据：base64 → UTF-8 → JSON 数组
    `$raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeNames(names)}'))`,
    '$names = @($raw | ConvertFrom-Json)',
    // WQL 字面量在脚本内部构造：单引号自身翻倍（[char]39）
    '$q = [char]39',
    '$parts = New-Object System.Collections.ArrayList',
    '$names | ForEach-Object {',
    '  $n = [string]$_',
    '  if ($n.Length -gt 0) { [void]$parts.Add("Name=" + $q + ($n -replace $q, ($q + $q)) + $q) }',
    '}',
    '$filter = ($parts -join " OR ")',
    /*
     * 取数：过滤只当**加速手段**，不是正确性依赖。
     *
     * WQL 的坑：`Name='a' OR Name='b'` 里只要有一段不合法（含双引号的名字会让
     * 字面量提前闭合），**整个查询直接报「无效查询」**，于是同批里所有正常服务
     * 一起变成「查不到」→ 界面把它们全报成「不在了」。一个畸形名字污染整批，
     * 这是本函数最需要防的失败模式。
     *
     * 所以过滤失败就回落到全量查询（304 条也就 2 秒），在结果里按名字挑 ——
     * 慢一点，但结论不会因为一个坏名字而错。
     */
    '$items = $null',
    'if (-not [string]::IsNullOrEmpty($filter)) {',
    '  try { $items = Get-CimInstance Win32_Service -Filter $filter -ErrorAction Stop }',
    '  catch { $items = $null }',
    '}',
    'if ($null -eq $items) { $items = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue }',
    'foreach ($s in $items) {',
    // 用数组 -join 构造记录，**不要**用 `+ $FS +` 串联。
    // 实测：同一个脚本里两种写法在 `Get-CimInstance -Filter` 的输出上没有差别，
    // 但在某些管道形态下 `+` 串联会把分隔符吃掉（只剩 3 个字段），于是
    // parseRows 因 fields.length < 5 把每条都丢掉，全量查询静默变成 0 条。
    // -join 这个形态在两种取数路径里都稳定产出 5 个字段。
    '  $row = @([string]$s.Name, [string]$s.DisplayName, [string]$s.State, [string]$s.StartMode, [string]$s.PathName)',
    '  [void]$out.Add($row -join $FS)',
    '}',
    '$out -join $RS'
  ].join('\n')
}

interface Row {
  name: string
  displayName: string
  state: ServiceRunState
  startMode: string
  path: string | null
}

function parseRows(output: string): Row[] {
  const rows: Row[] = []
  for (const record of output.split(RECORD)) {
    const text = record.trim()
    if (text.length === 0) continue
    const fields = text.split(FIELD)
    if (fields.length < 5) continue
    const [name, displayName, state, startMode, pathName] = fields
    if (name.length === 0) continue
    rows.push({
      name,
      displayName: displayName.length > 0 ? displayName : name,
      state: mapState(state),
      startMode: startMode.length > 0 ? startMode : '未知',
      path: pathName.trim().length > 0 ? pathName.trim() : null
    })
  }
  return rows
}

/**
 * 采集被关注服务的当前状态。
 *
 * 两种情况必须分开，这是本函数最容易做错的地方：
 *   · **采到了但查不到某个服务** → 仍然返回该项并标 `missing: true`。静默消失会让
 *     人以为关注清单坏了，而「这个服务不在了」本身就是运维信息；
 *   · **压根没采到**（PowerShell 失败 / 超时）→ 返回 `{ items: [], degraded: true }`。
 *     绝不能把「读不到」展开成「每个服务都 missing」—— 那等于把一次采集故障说成
 *     「你关注的服务全被卸载了」，会触发一轮假警报。
 */
export async function collectServices(
  names: readonly string[]
): Promise<{ items: ServiceStatus[]; degraded: boolean; error?: string }> {
  const wanted = names.filter((name) => name.trim().length > 0)
  if (wanted.length === 0) return { items: [], degraded: false }

  let rows: Row[] = []
  try {
    rows = parseRows(await runPowerShell(emitScript(wanted), 20000))
  } catch (error) {
    /*
     * 采集失败：**返回空数组，不返回「每个关注服务都 missing」**。
     *
     * 早前这里只把 degraded 置真就继续往下走 —— rows 为空意味着每一项都查不到，
     * 于是每个关注服务都被构造成 missing:true。后果是任何一次瞬时采集失败
     * （20s 超时、WMI 不可用、策略拦截）都被解释成「所有关注服务已从本机消失」：
     * 后台盯梢为每个服务发一条「本机已没有这个服务」，恢复后再整批发一轮
     * 「已恢复」。一次故障 = 一轮假警报风暴。
     *
     * 空数组让上游那条「关注清单非空却一条都没采到 = 这一拍失败，保留基线」的
     * 守卫真正生效（services/monitor.ts 的 #tick）。missing 的语义是「服务真的
     * 被卸载了」，不能被一次读失败冒用。
     *
     * 原因要一起带出去：界面只说「读不到」而不说为什么，用户无从判断是自己
     * 机器上 PowerShell 被策略挡了、还是运维舱出了问题。这里的信息此前被
     * `catch {` 直接丢掉。
     */
    const message = error instanceof Error ? error.message : String(error)
    return { items: [], degraded: true, error: message }
  }

  const byName = new Map(rows.map((row) => [row.name.toLowerCase(), row]))
  const items: ServiceStatus[] = wanted.map((name) => {
    const row = byName.get(name.toLowerCase())
    if (!row) {
      return {
        name,
        label: name,
        displayName: name,
        state: 'unknown',
        startMode: '未知',
        path: null,
        missing: true
      }
    }
    return {
      name: row.name,
      label: name,
      displayName: row.displayName,
      state: row.state,
      startMode: row.startMode,
      path: row.path,
      missing: false
    }
  })

  return { items, degraded: false }
}

/** 全部服务（添加对话框的候选，只在打开对话框时调一次） */
export async function listServiceCandidates(): Promise<ServiceCandidate[]> {
  const rows = parseRows(await runPowerShell(emitScript([]), 25000))
  return rows
    .map((row) => ({
      name: row.name,
      displayName: row.displayName,
      state: row.state,
      startMode: row.startMode
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
}
