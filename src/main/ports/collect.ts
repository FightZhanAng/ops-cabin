import { spawn } from 'node:child_process'
import type { PortEntry, PortProtocol, PortsSnapshot } from '../../shared/ports'
import { runPowerShell } from '../powershell'

/* ------------------------------------------------------------ netstat */

interface RawListener {
  protocol: PortProtocol
  port: number
  address: string
  pid: number
}

function runNetstat(timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('netstat.exe', ['-ano'], { windowsHide: true })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('netstat 超时'))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`netstat 退出码 ${code}`))
    })
  })
}

/**
 * 解析 netstat -ano：
 *   TCP 行取 LISTENING（状态词不本地化，英文匹配稳定）；
 *   UDP 是无连接协议没有状态列，直接收。
 */
export function parseNetstat(output: string): RawListener[] {
  const listeners: RawListener[] = []
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    const proto = parts[0]
    if (proto !== 'TCP' && proto !== 'UDP') continue
    const protocol: PortProtocol = proto === 'TCP' ? 'tcp' : 'udp'
    const local = parts[1]
    if (!local) continue
    if (protocol === 'tcp' && parts[3] !== 'LISTENING') continue
    const pid = Number(protocol === 'tcp' ? parts[4] : parts[3])
    if (!Number.isInteger(pid) || pid < 0) continue
    const colon = local.lastIndexOf(':')
    if (colon < 0) continue
    const address = local.slice(0, colon)
    const port = Number(local.slice(colon + 1))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    listeners.push({ protocol, port, address, pid })
  }
  return listeners
}

/* ------------------------------------------------------------ 进程表 */

interface ProcessInfo {
  name: string
  path: string | null
  commandLine: string | null
  memoryBytes: number
  startedAt: number
}

const PROCESS_TABLE_TTL = 10_000

/**
 * 进程信息缓存（10 秒）。
 * 新启动的进程在缓存里不存在时会强制刷新一次 —— 刚起的开发服务器
 * 不该等到缓存过期才能在界面上认出名字。
 */
class ProcessTable {
  #map = new Map<number, ProcessInfo>()
  #fetchedAt = 0
  #inflight: Promise<void> | null = null

  async get(): Promise<Map<number, ProcessInfo>> {
    if (Date.now() - this.#fetchedAt > PROCESS_TABLE_TTL) await this.#refresh()
    return this.#map
  }

  async refreshIfMissing(pids: number[]): Promise<Map<number, ProcessInfo>> {
    const hasMissing = pids.some((pid) => pid > 0 && !this.#map.has(pid))
    if (hasMissing) await this.#refresh()
    return this.#map
  }

  #refresh(): Promise<void> {
    if (this.#inflight) return this.#inflight
    this.#inflight = (async () => {
      try {
        this.#map = await fetchProcessTable()
      } catch {
        /* 进程表拿不到：保留旧表，采集降级但可用 */
      } finally {
        this.#fetchedAt = Date.now()
        this.#inflight = null
      }
    })()
    return this.#inflight
  }
}

const processTable = new ProcessTable()

async function fetchProcessTable(): Promise<Map<number, ProcessInfo>> {
  const script = [
    '$items = Get-CimInstance Win32_Process | ForEach-Object {',
    '  $cmd = $_.CommandLine',
    '  if ($cmd -ne $null -and $cmd.Length -gt 512) { $cmd = $cmd.Substring(0, 512) }',
    '  $created = 0',
    '  if ($_.CreationDate) { $created = [long](($_.CreationDate.ToUniversalTime().Ticks - 621355968000000000) / 10000) }',
    '  [PSCustomObject]@{ pid = $_.ProcessId; name = $_.Name; path = $_.ExecutablePath; cmd = $cmd; mem = $_.WorkingSetSize; created = $created }',
    '}',
    'ConvertTo-Json -InputObject @($items) -Compress -Depth 3'
  ].join('\n')

  const output = await runPowerShell(script, 20000)
  const map = new Map<number, ProcessInfo>()
  let rows: unknown
  try {
    rows = JSON.parse(output)
  } catch {
    return map
  }
  const list = Array.isArray(rows) ? rows : [rows]
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const pid = Number(rec.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    map.set(pid, {
      name: typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : `PID ${pid}`,
      path: typeof rec.path === 'string' ? rec.path : null,
      commandLine: typeof rec.cmd === 'string' ? rec.cmd : null,
      memoryBytes: Number.isFinite(Number(rec.mem)) ? Number(rec.mem) : 0,
      startedAt: Number.isFinite(Number(rec.created)) ? Number(rec.created) : 0
    })
  }
  return map
}

/* ------------------------------------------------------------ 采集 */

export async function collectPorts(watchedPorts: number[] = []): Promise<PortsSnapshot> {
  const started = Date.now()
  const netstatOutput = await runNetstat()
  const listeners = parseNetstat(netstatOutput)

  await processTable.get()
  const table = await processTable.refreshIfMissing(listeners.map((l) => l.pid))

  const watched = new Set(watchedPorts)
  const byKey = new Map<string, PortEntry>()
  for (const listener of listeners) {
    const key = `${listener.protocol}:${listener.port}`
    const info = table.get(listener.pid)
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.addresses.includes(listener.address)) {
        existing.addresses.push(listener.address)
      }
      // 同协议同端口出现多个 PID（UDP 可共享绑定）：保留已有信息，仅登记
      continue
    }
    byKey.set(key, {
      protocol: listener.protocol,
      port: listener.port,
      addresses: [listener.address],
      pid: listener.pid,
      processName: info?.name ?? null,
      processPath: info?.path ?? null,
      commandLine: info?.commandLine ?? null,
      memoryBytes: info?.memoryBytes ?? null,
      startedAt: info?.startedAt ?? null,
      watched: watched.has(listener.port)
    })
  }

  const entries = [...byKey.values()].sort(
    (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)
  )

  return {
    at: Date.now(),
    entries,
    durationMs: Date.now() - started,
    degraded: entries.length > 0 && entries.some((entry) => entry.processName === null)
  }
}
