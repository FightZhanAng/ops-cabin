import type { JSX } from 'react'
import { cn } from 'cn'

interface Props {
  /** 数据点（旧的在前） */
  series: number[]
  /** 满量程（默认 100） */
  max?: number
  className?: string
}

/** 迷你走势线：SVG 折线（≤60 点）；是仪表读数旁的痕迹，不喧宾夺主 */
export function Sparkline({ series, max = 100, className }: Props): JSX.Element {
  const width = 100
  const height = 26
  if (series.length < 2) {
    return <div className={cn('h-[26px] w-full', className)} aria-hidden />
  }
  const step = width / (series.length - 1)
  const points = series
    .map((value, index) => {
      const x = index * step
      const y = height - (Math.min(Math.max(value, 0), max) / max) * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('h-[26px] w-full', className)}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--dim)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
