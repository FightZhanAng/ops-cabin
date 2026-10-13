/** 扫描分组 */
export type ScanGroupKey = 'safe' | 'devCaches' | 'largeFiles'

/** 清理风险等级：safe 重下即可重建；careful 清理成本较高 */
export type RiskLevel = 'safe' | 'careful'

/** 一个可勾选的清理候选 */
export interface ScanItem {
  /** 稳定 id（就是绝对路径） */
  id: string
  /** 展示名 */
  label: string
  /** 绝对路径 */
  path: string
  group: ScanGroupKey
  risk: RiskLevel
  /** 大小（字节） */
  bytes: number
  /** 文件数 */
  files: number
  /** 补充说明（如「重新下载成本较高」） */
  note?: string
}

export interface ScanGroupResult {
  group: ScanGroupKey
  items: ScanItem[]
  /** 该组合计大小 */
  bytes: number
}

/** 扫描进度（约每 200ms 推一条） */
export interface ScanProgress {
  phase: 'measuring' | 'largeFiles'
  /** 当前正在处理的路径 */
  current: string
  /** 已浏览的文件数 */
  scannedFiles: number
  /** 已发现的候选数 */
  found: number
}

export interface ScanResult {
  at: number
  durationMs: number
  groups: ScanGroupResult[]
  /** 因权限/占用等原因跳过的条目总数（可见的"看不见的失败"对账口径） */
  skipped: number
}

/** 扫描调用的结果：正常完成，或被取消 / 出错 */
export type ScanOutcome =
  | { ok: true; result: ScanResult }
  | { ok: false; cancelled: boolean; error?: string }

/** 渲染层发起扫描的参数 */
export interface ScanOptions {
  /** 要扫描的分组；缺省为 safe + devCaches */
  groups?: ScanGroupKey[]
  /** 大文件扫描的根目录（largeFiles 组使用；不传时主进程会默认用用户主目录） */
  largeFileRoots?: string[]
  /** 大文件阈值（字节），缺省 100MB */
  largeFileMinBytes?: number
}

/* ------------------------------------------------------------ 清理 */

export type CleanMode = 'recycle' | 'permanent'

/** 渲染层请求清理的一项 */
export interface CleanRequestItem {
  path: string
  /** 扫描时记录的字节数（用于汇总释放量） */
  bytes: number
}

export interface CleanFailure {
  path: string
  error: string
}

export interface CleanResult {
  at: number
  mode: CleanMode
  /** 成功删除的项数 */
  succeeded: number
  failed: CleanFailure[]
  /** 释放字节（按扫描值求和，仅含成功项） */
  freedBytes: number
  /** 确认已不在磁盘上的路径（成功删除 + 本来就不存在）——界面据此把行移除 */
  removed: string[]
}

/** 清理调用的结果 */
export type CleanOutcome = { ok: true; result: CleanResult } | { ok: false; error: string }

/**
 * 一次清理的历史记录（userData/clean-history.json 的条目）。
 * 由主进程在清理成功后追加，总览的统计图只读消费。
 */
export interface CleanHistoryEntry {
  at: number
  mode: CleanMode
  freedBytes: number
  itemCount: number
}

/* ------------------------------------------------------------ 分区 */

export interface VolumeInfo {
  /** 盘符，如 "C:" */
  name: string
  used: number
  free: number
  total: number
}
