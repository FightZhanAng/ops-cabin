import type { JSX } from 'react'
import type { CleanHistoryEntry } from '@shared/disk'
import { formatBytes, formatCount, formatStamp } from '@shared/format'
import { cn } from 'cn'

/*
 * 清理记录统计：14 天柱状图（每天释放量）+ 30 天累计折线 + 汇总读数。
 *
 * 数据来自主进程的 clean-history.json（每次清理成功追加一条），这里只读。
 * 画法沿用仪表盘的路子：柱 = 直角方柱（石墨墨阶，不借用信号色），
 * 折线 = 描边 1.5px 的读数痕迹；坐标不做花哨装饰，日期标签用等宽小字。
 */

const BAR_DAYS = 14
const TREND_DAYS = 30
const TREND_W = 300
const TREND_H = 64

/** 本地零点：走日历减法（setDate），抵消夏令时偏移 */
function dayStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 最近 n 天的零点列表（升序，末尾是今天） */
function recentDays(n: number): number[] {
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - (n - 1))
  cursor.setHours(0, 0, 0, 0)
  const days: number[] = []
  for (let i = 0; i < n; i++) {
    days.push(cursor.getTime())
    cursor.setDate(cursor.getDate() + 1)
    cursor.setHours(0, 0, 0, 0)
  }
  return days
}

/** 柱状图的日期轴标签（只要月-日） */
function monthDay(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

interface Aggregated {
  barDays: { day: number; bytes: number }[]
  /** 30 天逐日累计（升序，末尾 = 今天的累计值） */
  trend: number[]
  totalBytes: number
  totalItems: number
  last: CleanHistoryEntry | null
  maxBar: number
  trendMax: number
  today: number
}

function aggregate(entries: CleanHistoryEntry[]): Aggregated {
  const byDay = new Map<number, number>()
  let totalBytes = 0
  let totalItems = 0
  for (const entry of entries) {
    const key = dayStart(entry.at)
    byDay.set(key, (byDay.get(key) ?? 0) + entry.freedBytes)
    totalBytes += entry.freedBytes
    totalItems += entry.itemCount
  }

  const barDays = recentDays(BAR_DAYS).map((day) => ({ day, bytes: byDay.get(day) ?? 0 }))
  const trendDays = recentDays(TREND_DAYS)
  let running = 0
  const trend = trendDays.map((day) => {
    running += byDay.get(day) ?? 0
    return running
  })

  return {
    barDays,
    trend,
    totalBytes,
    totalItems,
    last: entries.length > 0 ? entries[entries.length - 1] : null,
    maxBar: Math.max(...barDays.map((item) => item.bytes), 1),
    trendMax: Math.max(...trend, 1),
    today: trendDays[trendDays.length - 1]
  }
}

/** 汇总读数：标签在上、读数在下（大字用 24px，与资源面板同阶） */
function Readout({ label, value, size = 'sm' }: { label: string; value: string; size?: 'sm' | 'lg' }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="eyebrow text-faint">{label}</div>
      <div
        className={cn(
          'num mt-0.5 truncate font-bold leading-none',
          size === 'lg' ? 'text-[24px]' : 'text-[15px]'
        )}
      >
        {value}
      </div>
    </div>
  )
}

interface Props {
  entries: CleanHistoryEntry[]
}

export function CleanupStats({ entries }: Props): JSX.Element {
  const stats = aggregate(entries)

  // 折线坐标（viewBox 固定，preserveAspectRatio=none 拉伸铺满）
  const step = stats.trend.length > 1 ? TREND_W / (stats.trend.length - 1) : TREND_W
  const points = stats.trend.map((value, index) => {
    const x = index * step
    const y = TREND_H - 2 - (value / stats.trendMax) * (TREND_H - 6)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const areaPath = `M${points[0]} L${points.slice(1).join(' L')} L${TREND_W},${TREND_H} L0,${TREND_H} Z`

  return (
    <div
      data-testid="cleanup-stats"
      data-total-bytes={stats.totalBytes}
      data-runs={entries.length}
      data-last-at={stats.last?.at ?? ''}
      className="flex flex-col gap-3"
    >
      {entries.length === 0 ? (
        <div className="py-1 text-[11px] leading-relaxed text-dim">
          还没有清理记录 —— 去磁盘页扫描并清理一次，这里会出现每天释放的空间量。
        </div>
      ) : (
        <>
          {/* 汇总读数 */}
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <Readout label="累计释放" value={formatBytes(stats.totalBytes)} size="lg" />
            <Readout label="清理次数" value={`${formatCount(entries.length)} 次`} />
            <Readout label="累计条目" value={formatCount(stats.totalItems)} />
            <Readout
              label="最近一次"
              value={stats.last ? `${formatStamp(stats.last.at)} · ${formatBytes(stats.last.freedBytes)}` : '—'}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {/* 柱状图：近 14 天每天释放量 */}
            <div className="min-w-0">
              <div className="eyebrow mb-1.5 text-faint">近 14 天 · 每天释放</div>
              <div className="flex h-[76px] items-end gap-[3px]" data-testid="cleanup-bars">
                {stats.barDays.map((item) => {
                  const isToday = item.day === stats.today
                  return (
                    <div
                      key={item.day}
                      data-testid="cleanup-bar"
                      className="flex h-full flex-1 items-end"
                      title={`${monthDay(item.day)} · ${item.bytes > 0 ? formatBytes(item.bytes) : '没有清理'}`}
                    >
                      <div
                        className="w-full rounded-[2px]"
                        style={{
                          height:
                            item.bytes > 0
                              ? `${Math.max((item.bytes / stats.maxBar) * 100, 6)}%`
                              : '2px',
                          background:
                            item.bytes > 0
                              ? isToday
                                ? 'var(--fg)'
                                : 'color-mix(in srgb, var(--fg) 62%, transparent)'
                              : 'var(--line)'
                        }}
                      />
                    </div>
                  )
                })}
              </div>
              <div className="num mt-1 flex justify-between text-[10.5px] text-faint">
                <span>{monthDay(stats.barDays[0].day)}</span>
                <span>今天 {monthDay(stats.today)}</span>
              </div>
            </div>

            {/* 折线图：近 30 天累计释放 */}
            <div className="min-w-0">
              <div className="eyebrow mb-1.5 text-faint">近 30 天 · 累计释放</div>
              <svg
                data-testid="cleanup-trend"
                viewBox={`0 0 ${TREND_W} ${TREND_H}`}
                preserveAspectRatio="none"
                className="h-[76px] w-full"
                aria-hidden
              >
                <line
                  x1="0"
                  y1={TREND_H - 0.5}
                  x2={TREND_W}
                  y2={TREND_H - 0.5}
                  stroke="var(--line)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                <path d={areaPath} fill="color-mix(in srgb, var(--fg) 8%, transparent)" stroke="none" />
                <polyline
                  points={points.join(' ')}
                  fill="none"
                  stroke="var(--fg)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
              <div className="num mt-1 flex justify-between text-[10.5px] text-faint">
                <span>30 天前</span>
                <span>{formatBytes(stats.trend[stats.trend.length - 1] ?? 0)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
