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

/** 服务名进 WQL 前先转义单引号，避免把脚本尾巴拼坏 */
function quoteWql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function mapState(raw: string): ServiceRunState {
  const text = raw.trim().toLowerCase()
  if (text === 'running') return 'running'
  if (text === 'stopped') return 'stopped'
  if (text.includes('pending') || text === 'paused' || text.includes('pause')) return 'pending'
  return 'unknown'
}

function emitScript(filter: string): string {
  return [
    '$FS = [char]31',
    '$RS = [char]30',
    '$out = New-Object System.Collections.ArrayList',
    `$filter = "${filter}"`,
    // 空 filter 必须走「不带 -Filter 的全量查询」：给 -Filter 传空串会报错，
    // 而「干脆返回空数组」会让「列出全部服务」这条路径静默失效（这里踩过）。
    'if ([string]::IsNullOrEmpty($filter)) {',
    '  $items = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue',
    '} else {',
    '  $items = Get-CimInstance Win32_Service -Filter $filter -ErrorAction SilentlyContinue',
    '}',
    'foreach ($s in $items) {',
    "  [void]$out.Add([string]$s.Name + $FS + [string]$s.DisplayName + $FS + [string]$s.State + $FS + [string]$s.StartMode + $FS + [string]$s.PathName)",
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
 * 关注清单里有、但本机查不到的项**仍然要返回**（missing: true）——
 * 静默消失会让人以为关注清单坏了；「这个服务不在了」本身就是运维信息。
 */
export async function collectServices(
  names: readonly string[]
): Promise<{ items: ServiceStatus[]; degraded: boolean }> {
  const wanted = names.filter((name) => name.trim().length > 0)
  if (wanted.length === 0) return { items: [], degraded: false }

  const filter = wanted.map((name) => `Name=${quoteWql(name)}`).join(' OR ')
  let rows: Row[] = []
  let degraded = false
  try {
    rows = parseRows(await runPowerShell(emitScript(filter), 20000))
  } catch {
    degraded = true
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

  return { items, degraded }
}

/** 全部服务（添加对话框的候选，只在打开对话框时调一次） */
export async function listServiceCandidates(): Promise<ServiceCandidate[]> {
  const rows = parseRows(await runPowerShell(emitScript(''), 25000))
  return rows
    .map((row) => ({
      name: row.name,
      displayName: row.displayName,
      state: row.state,
      startMode: row.startMode
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
}
