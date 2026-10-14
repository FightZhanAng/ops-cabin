import { cpus } from 'node:os'
import type { ProcEntry } from '../shared/processes'
import { runPowerShell } from './powershell'

/*
 * 进程表：端口页（给监听端口认领进程）与总览的进程榜共用一份采集。
 *
 * CPU 占用怎么算：Win32_Process 自带 KernelModeTime / UserModeTime（累计 100ns），
 * 同一个查询里就拿到了，不用再去问 Win32_PerfFormattedData_PerfProc_Process ——
 * 那条路要多等一个性能计数器的采样周期（实测 +2.5s），而且它在进程表之外。
 * 代价是「第一次查询没有基线」，CPU 列要等第二次采样才有值，见 top()。
 *
 * 归一化：Kernel+User 的增量 ÷ 墙钟增量 ÷ 逻辑核数 —— 得到的是「占总 CPU 的百分比」，
 * 和任务管理器一列的口径一致（单进程最多 100%，而不是 100%×核数）。
 */

/** 进程表缓存有效期：端口页每 2s 采一次，不缓存会把 PowerShell 打满 */
const PROCESS_TABLE_TTL = 10_000
/**
 * 建立基线后的补采样等待。
 * 只是个下限 —— 第二次采集要新起一个 PowerShell 进程（约 1.4s），
 * 真实的差分窗口是「两次采集之间」，比这个值大。
 */
const BASELINE_WAIT = 300

/** 100ns → 秒 */
const TICKS_PER_SECOND = 10_000_000
const CORE_COUNT = Math.max(1, cpus().length)

export interface ProcessInfo {
  name: string
  path: string | null
  commandLine: string | null
  memoryBytes: number
  /** 进程启动时间（epoch ms）；取不到为 0 */
  startedAt: number
  /** 占总 CPU 的百分比（0-100，一位小数）；还没有基线时为 null */
  cpuPercent: number | null
}

/** CPU 差分基线：只要时间戳与累计值，不需要留整张进程表 */
interface CpuBaseline {
  at: number
  ticks: Map<number, number>
}

interface Snapshot {
  at: number
  ticks: Map<number, number>
  entries: Map<number, ProcessInfo>
  /** 这次快照里是否真的算出了 CPU 值（有基线且窗口够长）—— 缓存新鲜不代表它可用 */
  hasCpu: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const QUERY_SCRIPT = [
  '$items = Get-CimInstance Win32_Process | ForEach-Object {',
  '  $cmd = $_.CommandLine',
  '  if ($cmd -ne $null -and $cmd.Length -gt 512) { $cmd = $cmd.Substring(0, 512) }',
  '  $created = 0',
  '  if ($_.CreationDate) { $created = [long](($_.CreationDate.ToUniversalTime().Ticks - 621355968000000000) / 10000) }',
  '  [PSCustomObject]@{',
  '    pid = $_.ProcessId; name = $_.Name; path = $_.ExecutablePath; cmd = $cmd;',
  '    mem = $_.WorkingSetSize; created = $created;',
  '    kernel = $_.KernelModeTime; user = $_.UserModeTime',
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($items) -Compress -Depth 3'
].join('\n')

/** 采一次原始快照；有基线时顺手把每进程的 CPU 占比算出来 */
async function fetchSnapshot(baseline: CpuBaseline | null): Promise<Snapshot> {
  const output = await runPowerShell(QUERY_SCRIPT, 20000)
  const at = Date.now()
  const entries = new Map<number, ProcessInfo>()
  const ticks = new Map<number, number>()

  let rows: unknown
  try {
    rows = JSON.parse(output)
  } catch {
    /*
     * 退出码 0 但内容不是预期 JSON（脚本被策略改写、输出混入告警文本等）。
     *
     * **必须抛出而不是返回空表**：`#refresh` 只在抛异常时才保留旧表，
     * 返回空 Map 会被当成「本机一个进程都没有」—— 进程榜与端口页的
     * 「哪个进程占了这个端口」会一起清空，而调用方还以为采集成功了。
     * 「读不到」不能伪装成「没有」。
     */
    throw new Error('进程表输出不是合法 JSON')
  }

  const list = Array.isArray(rows) ? rows : [rows]
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const pid = Number(rec.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const total = Number(rec.kernel) + Number(rec.user)
    if (Number.isFinite(total) && total > 0) ticks.set(pid, total)
    entries.set(pid, {
      name: typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : `PID ${pid}`,
      path: typeof rec.path === 'string' ? rec.path : null,
      commandLine: typeof rec.cmd === 'string' ? rec.cmd : null,
      memoryBytes: Number.isFinite(Number(rec.mem)) ? Number(rec.mem) : 0,
      startedAt: Number.isFinite(Number(rec.created)) ? Number(rec.created) : 0,
      cpuPercent: null
    })
  }

  const elapsedSeconds = baseline ? (at - baseline.at) / 1000 : 0
  // 窗口太短时差分会放大噪声（同一毫秒内的两次采样毫无意义），宁可不显示
  const hasCpu = baseline !== null && elapsedSeconds >= 0.2
  if (hasCpu && baseline) {
    for (const [pid, entry] of entries) {
      const now = ticks.get(pid)
      const before = baseline.ticks.get(pid)
      if (now === undefined || before === undefined) continue
      const delta = now - before
      // 进程重启后累计值归零：负增量丢弃，别画出一根负占用
      if (delta < 0) continue
      const percent = (delta / TICKS_PER_SECOND / elapsedSeconds / CORE_COUNT) * 100
      entry.cpuPercent = Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10
    }
  }

  return { at, ticks, entries, hasCpu }
}

function toEntry(pid: number, info: ProcessInfo): ProcEntry {
  return { pid, name: info.name, memoryBytes: info.memoryBytes, cpuPercent: info.cpuPercent }
}

/** 内存 Top N ∪ CPU Top N 的并集（切排序键时不会漏掉「小内存但吃满 CPU」的进程） */
function rank(entries: Map<number, ProcessInfo>, limit: number): ProcEntry[] {
  const all = [...entries.entries()]
  const byMemory = [...all].sort((a, b) => b[1].memoryBytes - a[1].memoryBytes).slice(0, limit)
  const byCpu = [...all]
    .sort((a, b) => (b[1].cpuPercent ?? -1) - (a[1].cpuPercent ?? -1))
    .slice(0, limit)
  const picked = new Map<number, ProcEntry>()
  for (const [pid, info] of [...byMemory, ...byCpu]) {
    if (!picked.has(pid)) picked.set(pid, toEntry(pid, info))
  }
  return [...picked.values()]
}

/**
 * 进程表缓存。
 * 新启动的进程在缓存里不存在时会强制刷新一次 —— 刚起的开发服务器
 * 不该等到缓存过期才能在界面上认出名字。
 */
class ProcessTable {
  #snapshot: Snapshot = { at: 0, ticks: new Map(), entries: new Map(), hasCpu: false }
  #baseline: CpuBaseline | null = null
  #inflight: Promise<void> | null = null

  async get(): Promise<Map<number, ProcessInfo>> {
    if (Date.now() - this.#snapshot.at > PROCESS_TABLE_TTL) await this.#refresh()
    return this.#snapshot.entries
  }

  async refreshIfMissing(pids: number[]): Promise<Map<number, ProcessInfo>> {
    const hasMissing = pids.some((pid) => pid > 0 && !this.#snapshot.entries.has(pid))
    if (hasMissing) await this.#refresh(true)
    return this.#snapshot.entries
  }

  /**
   * 进程榜。
   *
   * CPU 要有两次采样才算得出来，所以这里的刷新判定不能只看缓存有效期：
   * 刚建立的基线虽然「新鲜」，但快照里一个 CPU 值都没有，必须再采一次。
   * 少了这一条，用户会盯着整列「—」直到 10 秒后缓存过期（踩过一次）。
   */
  async top(limit: number): Promise<ProcEntry[]> {
    if (this.#baseline === null) {
      await this.#refresh(true)
      await sleep(BASELINE_WAIT)
    }
    if (!this.#snapshot.hasCpu || Date.now() - this.#snapshot.at > PROCESS_TABLE_TTL) {
      await this.#refresh(true)
    }
    return rank(this.#snapshot.entries, limit)
  }

  #refresh(force = false): Promise<void> {
    if (this.#inflight) return this.#inflight
    if (!force && Date.now() - this.#snapshot.at <= PROCESS_TABLE_TTL) return Promise.resolve()
    this.#inflight = (async () => {
      try {
        const next = await fetchSnapshot(this.#baseline)
        this.#baseline = { at: next.at, ticks: next.ticks }
        this.#snapshot = next
      } catch {
        /* 进程表拿不到：保留旧表，采集降级但可用 */
      } finally {
        this.#inflight = null
      }
    })()
    return this.#inflight
  }
}

export const processTable = new ProcessTable()
