import type { JSX } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { cn } from '@/lib/utils'

interface Props {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'system', label: '跟随系统', icon: Monitor },
  { mode: 'dark', label: '深色', icon: Moon }
]

/** 主题三档：把选择灌进 nativeTheme，配色由 prefers-color-scheme 自动跟随 */
export function ThemePicker({ value, onChange }: Props): JSX.Element {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg bg-panel-2 p-1"
      data-testid="theme-picker"
    >
      {OPTIONS.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          data-testid={`theme-${mode}`}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors duration-150',
            value === mode
              ? 'bg-panel font-medium text-fg shadow-sm'
              : 'text-dim hover:text-fg'
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}
