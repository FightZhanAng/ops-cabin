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
