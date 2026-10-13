/** 一次系统资源采样 */
export interface MetricsSample {
  at: number
  /** CPU 总占用率（0-100，一位小数） */
  cpuPercent: number
  /** 已用内存（字节） */
  memUsed: number
  /** 总内存（字节） */
  memTotal: number
  /** 下行字节/秒；还没攒够两次网卡计数时为 null（界面显示 —） */
  netRxBps: number | null
  /** 上行字节/秒；同 netRxBps */
  netTxBps: number | null
}
