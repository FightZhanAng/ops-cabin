import type { JSX } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { cn } from 'cn'

/*
 * 侧栏左下角的主题三档拨档（参考图：浅底胶囊 + 活动档白底胶囊）。
 * 与 Rocker 同一套「活动档」语义（bg-panel + line-2 内描边，不投影），
 * 只是这一处按参考图用全圆角；收起侧栏时纵向排一列，交互不变。
 */

const OPTIONS = [
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '亮色', icon: Sun }
] as const

interface Props {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
  /** 侧栏收起时纵向排列 */
  collapsed?: boolean
  className?: string
}

export function ThemeSwitch({ value, onChange, collapsed = false, className }: Props): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="主题"
      data-testid="theme-switch"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-line-2 bg-panel-2 p-[3px]',
        collapsed ? 'flex-col' : 'flex-row',
        className
      )}
    >
      {OPTIONS.map((option) => {
        const active = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            data-testid={`theme-${option.value}`}
            data-active={active ? 'true' : 'false'}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex cursor-pointer items-center justify-center rounded-full transition-colors duration-150',
              collapsed ? 'size-7' : 'h-7 flex-1',
              active
                ? 'bg-panel text-fg shadow-[inset_0_0_0_1px_var(--line-2)]'
                : 'text-dim hover:text-fg'
            )}
          >
            <Icon size={14} />
          </button>
        )
      })}
    </div>
  )
}
