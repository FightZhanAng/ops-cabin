import type { CSSProperties, JSX } from 'react'
import { cn } from 'cn'

/** 分段条的语义色调：与仪表灯同一组变量 */
export type SegTone = 'ok' | 'warn' | 'danger' | 'ink'
export type SegSize = 'xs' | 'sm' | 'md'

const TONE_VAR: Record<SegTone, string> = {
  ok: 'var(--ok-soft)',
  warn: 'var(--warn-soft)',
  danger: 'var(--danger-soft)',
  ink: 'var(--fg)'
}

const SIZE_HEIGHT: Record<SegSize, number> = { xs: 5, sm: 7, md: 9 }

/** 负载色调：<warn 正常，>=warn 注意，>=danger 危险（CPU / 内存用） */
export function loadTone(percent: number, warn = 80, danger = 92): SegTone {
  if (percent >= danger) return 'danger'
  if (percent >= warn) return 'warn'
  return 'ok'
}

/** 剩余空间色调：<5GB 危险，<10GB 注意（磁盘用） */
export function freeTone(freeBytes: number): SegTone {
  if (freeBytes < 5 * 1024 ** 3) return 'danger'
  if (freeBytes < 10 * 1024 ** 3) return 'warn'
  return 'ok'
}

interface Props {
  /** 0–1 */
  ratio: number
  tone?: SegTone
  segments?: number
  size?: SegSize
  /** 扫描进行中：条面叠加一道扫掠光带 */
  sweep?: boolean
  className?: string
  'aria-label'?: string
}

/** 分段仪表条：离散 LED 格而不是连续进度条 —— 每一格都是可数的单位 */
export function SegBar({
  ratio,
  tone = 'ink',
  segments = 28,
  size = 'sm',
  sweep = false,
  className,
  ...rest
}: Props): JSX.Element {
  const safe = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0
  const lit = Math.round(safe * segments)

  return (
    <div
      role="progressbar"
      aria-label={rest['aria-label']}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safe * 100)}
      className={cn('relative flex w-full items-stretch overflow-hidden', className)}
      style={{ height: SIZE_HEIGHT[size], gap: 2, '--seg': TONE_VAR[tone] } as CSSProperties}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          className="min-w-0 flex-1 rounded-[1px] transition-colors duration-200"
          style={{
            background:
              index < lit ? 'var(--seg)' : 'color-mix(in srgb, var(--seg) 16%, transparent)'
          }}
        />
      ))}
      {sweep && (
        <span
          className="seg-sweep pointer-events-none absolute inset-y-0 left-0 w-1/3"
          style={{
            background:
              'linear-gradient(90deg, transparent, color-mix(in srgb, var(--fg) 30%, transparent), transparent)'
          }}
        />
      )}
    </div>
  )
}
