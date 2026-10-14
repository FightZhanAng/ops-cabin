/** 端口监听条目的传输协议 */
export type PortProtocol = 'tcp' | 'udp'

/** 一个正在监听的端口条目（同协议同端口的多地址已合并） */
export interface PortEntry {
  protocol: PortProtocol
  port: number
  /** 监听地址（可能多个，如 0.0.0.0 与 [::]） */
  addresses: string[]
  pid: number
  /** 进程名（如 node.exe）；拿不到时为 null */
  processName: string | null
  /** 进程可执行文件路径 */
  processPath: string | null
  /** 命令行（截断） */
  commandLine: string | null
  /** 进程内存（字节） */
  memoryBytes: number | null
  /** 进程启动时间（Unix 毫秒） */
  startedAt: number | null
  /** 是否在关注清单里 */
  watched: boolean
}

/** 关注清单项 */
export interface WatchItem {
  port: number
  label: string
  note?: string
  addedAt: number
}

/** 关注端口的变化类型 */
export type PortChangeType = 'occupy' | 'release' | 'change'

/** 关注端口的一次变化 */
export interface PortChange {
  at: number
  type: PortChangeType
  port: number
  /** 变化后的占用进程描述（release 时为 null） */
  process: string | null
  /** 变化前的占用进程描述（occupy 时为 null） */
  previous: string | null
}

/** 一次端口采样 */
export interface PortsSnapshot {
  at: number
  entries: PortEntry[]
  /** 采集耗时（毫秒） */
  durationMs: number
  /** 进程信息不完整时为 true（降级但可用） */
  degraded: boolean
}

/** 新增关注项的输入 */
export interface WatchInput {
  port: number
  label: string
  note?: string
}

/** 结束进程的执行结果 */
export interface KillResult {
  ok: boolean
  /** 是否走到了强制终止（/F） */
  forced: boolean
  error?: string
}

/** 一个监听者的描述：进程名 + PID —— 界面展示与变化检测共用 */
export function describeOccupant(entry: { processName: string | null; pid: number }): string {
  return `${entry.processName ?? '未知进程'} (PID ${entry.pid})`
}

/**
 * 某个端口当前的占用描述（null = 没在监听）。
 *
 * **必须按协议算全，不能只取第一条。** 条目键是「协议:端口」（见 collect.ts），
 * TCP 445 与 UDP 445 是两条独立条目，而关注清单只记端口号。早前基线与变化检测
 * 各写一遍 `entries.find(e => e.port === p)`，只拿到排序后的第一条（TCP 在前），
 * 于是同号的 UDP 那半永远不进变化检测：UDP 侧被占用或释放不产生任何提醒，
 * 而显示的占用者也可能不是真正变化的那一个。
 *
 * 描述里带协议前缀，两个协议各自的占用者都能区分；跨协议的描述按稳定顺序拼接，
 * 直接当字符串比较即可（变化检测就是拿它当快照值）。
 */
export function describePortOccupants(
  entries: readonly PortEntry[],
  port: number
): string | null {
  const matches = entries.filter((entry) => entry.port === port)
  if (matches.length === 0) return null
  return matches
    .map((entry) => `${entry.protocol.toUpperCase()} ${describeOccupant(entry)}`)
    .sort()
    .join('；')
}
