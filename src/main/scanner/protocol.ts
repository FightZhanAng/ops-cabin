import type { RiskLevel, ScanProgress, ScanResult } from '../../shared/disk'

/** 主进程展开后的扫描目标（绝对路径 + 元数据） */
export interface ResolvedTarget {
  group: 'safe' | 'devCaches'
  label: string
  path: string
  risk: RiskLevel
  note?: string
}

/** 主进程 → 扫描进程的任务描述（纯数据，走结构化克隆） */
export interface WorkerTask {
  targets: ResolvedTarget[]
  largeFileRoots: string[]
  largeFileMinBytes: number
  /** 白名单：小写规范化后的绝对路径（前缀命中即排除） */
  exclude: string[]
  /** 大文件保留条数 */
  largeTopN: number
}

/** 扫描进程 → 主进程的消息 */
export type WorkerMessage =
  | { type: 'progress'; value: ScanProgress }
  | { type: 'done'; value: ScanResult }
  | { type: 'fatal'; message: string }
