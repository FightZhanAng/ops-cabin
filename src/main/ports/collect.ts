import { spawn } from 'node:child_process'
import type { PortEntry, PortProtocol, PortsSnapshot } from '../../shared/ports'
import { processTable } from '../processes'

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

/*
 * 进程表已抽到 src/main/processes.ts —— 端口页与总览的进程榜共用一份采集，
 * 免得两个页面各spawn一个 PowerShell 去问同一件事。
 */

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
