import { useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import type { PortEntry, WatchItem } from '@shared/ports'
import { cn } from 'cn'

const SIZE = 176
const C = SIZE / 2
const RIM = 78
const RING = [24, 48, 72] as const
/** 内环 = TCP 轨道，外环 = UDP 轨道 */
const R_TCP = 48
const R_UDP = 72

/**
 * 端口 → 方位角（0° 正上方，顺时针）。用平方根刻度而不是线性刻度：
 * 线性刻度会把 80 / 135 / 443 全挤在 12 点钟一条线上，而 sqrt 让 0–1000 与
 * 60000+ 的端口都能占住自己的方位（刻度标签 1K/4K/16K/36K/64K 即按此换算）。
 */
function angleOf(port: number): number {
  const clamped = Math.min(Math.max(port, 0), 65536)
  return Math.sqrt(clamped / 65536) * 360
}

function polarAt(angle: number, radius: number): { x: number; y: number } {
  const rad = ((angle - 90) * Math.PI) / 180
  return { x: C + radius * Math.cos(rad), y: C + radius * Math.sin(rad) }
}

const TICKS = [
  { port: 1024, label: '1K' },
  { port: 4096, label: '4K' },
  { port: 16384, label: '16K' },
  { port: 36864, label: '36K' },
  { port: 65536, label: '64K' }
] as const

interface Props {
  watchlist: WatchItem[]
  entries: PortEntry[]
  className?: string
}

/** 端口雷达：全部监听端口是背景回声（暗点），关注端口是目标（亮点/空圈）；扫描线一圈 4.5s */
export function Scope({ watchlist, entries, className }: Props): JSX.Element {
  const [cursor, setCursor] = useState<string | null>(null)

  const blips = useMemo(() => {
    const watched = new Set(watchlist.map((item) => item.port))
    const echoes = entries
      .filter((entry) => !watched.has(entry.port))
      .map((entry) => ({
        key: `${entry.protocol}-${entry.port}`,
        ...polarAt(angleOf(entry.port), entry.protocol === 'tcp' ? R_TCP : R_UDP)
      }))
    const targets = watchlist.map((item) => {
      const entry = entries.find((candidate) => candidate.port === item.port) ?? null
      const radius = entry ? (entry.protocol === 'tcp' ? R_TCP : R_UDP) : R_TCP
      return { item, entry, occupied: entry !== null, ...polarAt(angleOf(item.port), radius) }
    })
    return { echoes, targets }
  }, [entries, watchlist])

  const occupiedCount = blips.targets.filter((target) => target.occupied).length
  const summary = `${entries.length} 监听 · ${watchlist.length} 关注 · ${occupiedCount} 占用`

  const wedge = useMemo(() => {
    const start = polarAt(-34, RIM)
    const end = polarAt(0, RIM)
    return `M ${C} ${C} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${RIM} ${RIM} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`
  }, [])

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`端口雷达：${watchlist.length} 个关注端口中 ${occupiedCount} 个占用，共 ${entries.length} 个监听端口`}
      >
        <defs>
          <radialGradient id="scope-sweep-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--warn-soft)" stopOpacity="0.36" />
            <stop offset="100%" stopColor="var(--warn-soft)" stopOpacity="0.02" />
          </radialGradient>
        </defs>

        {/* 外框与轨道环 */}
        <circle cx={C} cy={C} r={RIM} fill="none" stroke="var(--line-2)" strokeWidth="1" />
        {RING.map((radius) => (
          <circle key={radius} cx={C} cy={C} r={radius} fill="none" stroke="var(--line)" strokeWidth="1" />
        ))}

        {/* 方位刻度（每 9° 一格，每 45° 加长） */}
        {Array.from({ length: 40 }, (_, index) => {
          const outer = polarAt(index * 9, RIM)
          const inner = polarAt(index * 9, RIM - (index % 5 === 0 ? 6 : 3))
          return (
            <line
              key={index}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="var(--line)"
              strokeWidth="1"
            />
          )
        })}

        {/* 十字准线 */}
        <line x1={C} y1={C - RIM} x2={C} y2={C + RIM} stroke="var(--line)" strokeDasharray="2 3" />
        <line x1={C - RIM} y1={C} x2={C + RIM} y2={C} stroke="var(--line)" strokeDasharray="2 3" />

        {/* 刻度标签 */}
        {TICKS.map((tick) => {
          const at = polarAt(angleOf(tick.port), RIM - 16)
          return (
            <text
              key={tick.label}
              x={at.x}
              y={at.y}
              className="num"
              fontSize="8"
              fill="var(--faint)"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {tick.label}
            </text>
          )
        })}

        {/* 扫描线（从 12 点方向起逆时针扫过 34°，4.5s 一圈） */}
        <g className="scope-sweep">
          <path d={wedge} fill="url(#scope-sweep-grad)" />
          <line x1={C} y1={C} x2={C} y2={C - RIM} stroke="var(--warn-soft)" strokeWidth="1" opacity="0.5" />
        </g>

        {/* 背景回声：未加入关注的监听端口 */}
        {blips.echoes.map((echo) => (
          <circle key={echo.key} cx={echo.x} cy={echo.y} r={1.6} fill="var(--faint)" opacity={0.55} />
        ))}

        {/* 目标：关注端口 */}
        {blips.targets.map((target) => {
          const detail = `${target.item.port} · ${target.entry ? target.entry.protocol.toUpperCase() : '未监听'} · ${target.entry?.processName ?? '—'} · ${target.occupied ? '占用' : '空闲'}`
          return (
            <g
              key={`target-${target.item.port}`}
              onMouseEnter={() =>
                setCursor(
                  `${target.item.port} · ${target.item.label} · ${target.occupied ? '占用中' : '空闲'}`
                )
              }
              onMouseLeave={() => setCursor(null)}
            >
              <title>{detail}</title>
              <circle cx={target.x} cy={target.y} r={8} fill="transparent" />
              {target.occupied ? (
                <>
                  <circle cx={target.x} cy={target.y} r={5} fill="var(--ok-soft)" opacity={0.25} />
                  <circle cx={target.x} cy={target.y} r={2.6} fill="var(--ok-soft)" />
                </>
              ) : (
                <circle
                  cx={target.x}
                  cy={target.y}
                  r={3}
                  fill="var(--panel)"
                  stroke="var(--line-2)"
                  strokeWidth={1.2}
                />
              )}
            </g>
          )
        })}
      </svg>

      <div className="w-full px-0.5">
        <div className="num truncate text-[10.5px] text-dim" data-testid="scope-readout">
          {cursor ?? summary}
        </div>
        <div className="flex w-full flex-col gap-0.5 pt-1 text-[10px] text-faint">
          <span className="num whitespace-nowrap">TCP 内环 · UDP 外环</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span
              className="lamp"
              style={{ width: 6, height: 6, '--lamp': 'var(--ok-soft)' } as CSSProperties}
            />
            占用
            <span
              className="ml-1 inline-block rounded-full border border-line-2"
              style={{ width: 6, height: 6 }}
            />
            空闲
          </span>
        </div>
      </div>
    </div>
  )
}
