import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { formatClock } from '@shared/format'
import type { TrendPoint } from '@shared/trend'
import { Rocker } from '@/components/instrument/rocker'

/*
 * 长期趋势：CPU 与内存的百分比曲线（每 5 分钟一个点，保留 7 天）。
 *
 * 两条线共用一个 0–100% 量程 —— 都是百分比，不需要第二根轴，也就不会出现
 * 「双轴各自缩放到差不多高」那种骗人的图。线一律走墨阶（CPU 用 --fg、内存用
 * --dim），颜色只用来区分系列，不用来表达好坏。
 */

const W = 600
const H = 100
/** 视图高度（px）；与 viewBox 高度解耦，靠 preserveAspectRatio="none" 拉伸 */
const CHART_H = 92

type RangeKey = '24h' | '7d'

const RANGE_MS: Record<RangeKey, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 }
const RANGE_LABEL: Record<RangeKey, string> = { '24h': '24 小时前', '7d': '7 天前' }

const RANGES = [
  { value: '24h' as const, label: '24 小时', testId: 'trend-range-24h' },
  { value: '7d' as const, label: '7 天', testId: 'trend-range-7d' }
]

function toPoints(values: number[]): string {
  if (values.length === 0) return ''
  const step = values.length > 1 ? W / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const y = H - (Math.min(Math.max(value, 0), 100) / 100) * H
      return `${(index * step).toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

export function ResourceTrend(): JSX.Element {
  const [points, setPoints] = useState<TrendPoint[]>([])
  const [range, setRange] = useState<RangeKey>('24h')

  useEffect(() => {
    let alive = true
    void window.opsCabin.listTrend().then((next) => {
      if (alive) setPoints(next)
    })
    return () => {
      alive = false
    }
  }, [])

  const visible = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range]
    return points.filter((point) => point.at >= cutoff)
  }, [points, range])

  const cpu = visible.map((point) => point.cpuPercent)
  const mem = visible.map((point) =>
    point.memTotal > 0 ? (point.memUsed / point.memTotal) * 100 : 0
  )
  const last = visible.length > 0 ? visible[visible.length - 1] : null
  const cpuPeak = cpu.length > 0 ? Math.max(...cpu) : 0
  const memPeak = mem.length > 0 ? Math.max(...mem) : 0

  return (
    <div
      data-testid="resource-trend"
      data-range={range}
      data-points={visible.length}
      data-cpu-peak={Math.round(cpuPeak * 10) / 10}
    >
      <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-0.5">
        <span className="num text-[11px] text-dim">
          {visible.length > 0
            ? `${visible.length} 个采样点 · 每 5 分钟一个`
            : '还没有攒够趋势点 —— 每 5 分钟落一个，开着放一会儿就有了'}
        </span>
        <Rocker
          options={RANGES.map((item) => ({ value: item.value, label: item.label, testId: item.testId }))}
          value={range}
          onChange={setRange}
          size="sm"
          aria-label="趋势时间窗"
          className="ml-auto"
        />
      </div>

      {visible.length === 0 ? (
        <div className="px-3.5 pb-3 text-[11px] leading-relaxed text-dim">
          趋势是攒出来的：现在只有瞬时读数，看不出「内存是不是一小时前开始涨的」。
        </div>
      ) : (
        <div className="px-3.5 pb-1">
          {/* 纵轴列只跟 SVG 同一行 —— 这样 100/50/0 三个刻度天然对齐图的上下边，
              不用靠 padding 去凑（凑出来的数字一改文案就错位，踩过一次） */}
          <div className="flex gap-2">
            <div className="num flex w-9 shrink-0 flex-col justify-between text-right text-[10.5px] text-faint">
              <span>100%</span>
              <span>50%</span>
              <span>0%</span>
            </div>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="min-w-0 flex-1"
              style={{ height: CHART_H }}
              aria-hidden
            >
              <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <polyline
                data-testid="trend-line-cpu"
                points={toPoints(cpu)}
                fill="none"
                stroke="var(--fg)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <polyline
                data-testid="trend-line-mem"
                points={toPoints(mem)}
                fill="none"
                stroke="var(--dim)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </div>
          {/* 横轴与图例：左缩进 44px = 纵轴列 36 + 间距 8，跟图左边缘对齐 */}
          <div className="ml-11">
            <div className="num mt-1 flex justify-between text-[10.5px] text-faint">
              <span>{RANGE_LABEL[range]}</span>
              <span>{last ? formatClock(last.at) : ''}</span>
            </div>
            <div className="mt-1 flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="h-[2px] w-4 shrink-0" style={{ background: 'var(--fg)' }} />
                <span className="text-[11px]">CPU 峰值 {cpuPeak.toFixed(1)}%</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-[2px] w-4 shrink-0" style={{ background: 'var(--dim)' }} />
                <span className="text-[11px]">内存峰值 {memPeak.toFixed(1)}%</span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
