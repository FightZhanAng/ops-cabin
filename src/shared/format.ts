/** 人类可读的字节数：1.9 GB / 356 MB / 12 KB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = ''
  for (const u of units) {
    value /= 1024
    unit = u
    if (value < 1024) break
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/** 数字千分位：12,345 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

/**
 * 速率：12.5 MB/s。
 * 无效输入直接给「—」（而不是「—/s」） —— 数据来源缺失时单位也不该出现。
 */
export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 时长（毫秒 → 45s / 13m / 2h 13m / 3d 4h） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

/**
 * 时钟 HH:mm:ss（用于变化时间线）。
 *
 * 与同文件其它格式化函数同一口径：无效输入给「—」而不是 `NaN:NaN:NaN` ——
 * 时间戳来自系统事件，读到坏值时该让人看出「这条数据不可信」，
 * 而不是把一个看起来像时间的乱码印在时间线上。
 */
export function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 过去某个时刻：今年 `MM-DD HH:mm`，跨年 `YYYY-MM-DD`。
 *
 * 用来显示「事件发生在什么时候」（清理记录、文件修改时间）。**不能用 formatClock**：
 * 只给时钟会把「三个月前改的」读成「今天改的」—— 而 hosts 的修改时间恰恰是判断
 * 「这条域名改写是不是最近刚被动过」的依据，日期读错等于结论读错。
 */
export function formatStamp(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (date.getFullYear() !== new Date(now).getFullYear()) return `${date.getFullYear()}-${monthDay}`
  return `${monthDay} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
