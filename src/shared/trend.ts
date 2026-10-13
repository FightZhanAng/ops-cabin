/**
 * 长期趋势的采样点。
 *
 * 现状（CPU/内存/网络）只有瞬时读数，看不出「是不是在慢慢涨」。这里每 5 分钟
 * 落一个点、保留 7 天，用来回答「内存是不是一小时前开始爬的」这类问题。
 * 所以每个点都是**那一刻的瞬时读数**（网卡是距上次读取的平均速率），不是区间均值。
 */
export interface TrendPoint {
  at: number
  /** CPU 总占用率（0-100） */
  cpuPercent: number
  memUsed: number
  memTotal: number
  /** 下行字节/秒；采不到时为 null */
  rxBps: number | null
  /** 上行字节/秒；采不到时为 null */
  txBps: number | null
}
