/** 进程榜的一行 */
export interface ProcEntry {
  pid: number
  name: string
  /** 工作集（字节） */
  memoryBytes: number
  /** 占总 CPU 的百分比（按逻辑核归一，0-100，一位小数）；还没有基线时为 null */
  cpuPercent: number | null
}
