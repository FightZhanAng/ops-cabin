import type { JSX } from 'react'

interface Props {
  /** 数据点（旧的在前） */
  series: number[]
  /** 满量程（默认 100） */
  max?: number
}

/** 迷你走势线：SVG 折线（≤60 点）；当前值以大字呈现，它只负责趋势暗示 */
export function Sparkline({ series, max = 100 }: Props): JSX.Element {
  const width = 100
  const height = 32
  if (series.length < 2) {
    return <div className="h-8" aria-hidden />
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
      className="h-8 w-full"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--signal)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
