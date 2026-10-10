import type { CSSProperties, JSX } from 'react'
import { cn } from 'cn'

/** 仪表灯的语义状态；颜色只在这里出现，且永远配文字标签使用 */
export type LampState = 'ok' | 'warn' | 'danger' | 'idle' | 'ink'

const STATE_VAR: Record<LampState, string> = {
  ok: 'var(--ok-soft)',
  warn: 'var(--warn-soft)',
  danger: 'var(--danger-soft)',
  idle: 'var(--line-2)',
  ink: 'var(--fg)'
}

interface Props {
  state?: LampState
  /** 呼吸闪烁：用于「进行中」的活体状态（尊重 prefers-reduced-motion） */
  pulse?: boolean
  size?: number
  /** 无障碍标签；省略时视为纯装饰（aria-hidden） */
  label?: string
  className?: string
}

/** 仪表灯：仪器面板上的状态点 */
export function Lamp({ state = 'idle', pulse = false, size = 7, label, className }: Props): JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      data-state={state}
      className={cn('lamp inline-block shrink-0', pulse && 'lamp-pulse', className)}
      style={{ width: size, height: size, '--lamp': STATE_VAR[state] } as CSSProperties}
    />
  )
}

/** 信号色变量（供 SVG / 内联场景复用，保证与 .lamp 同源） */
export function lampVar(state: LampState): string {
  return STATE_VAR[state]
}
