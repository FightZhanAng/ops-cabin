import type { JSX } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { Rocker } from '@/components/instrument/rocker'

interface Props {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}

/** 档位标签：图标 + 文字（颜色不承载含义，档位本身说明状态） */
function OptionLabel({ icon: Icon, text }: { icon: typeof Sun; text: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3" />
      {text}
    </span>
  )
}

/** 主题三档拨档：把选择灌进 nativeTheme，配色由 prefers-color-scheme 自动跟随 */
export function ThemePicker({ value, onChange }: Props): JSX.Element {
  return (
    <div data-testid="theme-picker">
      <Rocker
        aria-label="主题"
        value={value}
        onChange={onChange}
        options={[
          { value: 'light', label: <OptionLabel icon={Sun} text="浅色" />, testId: 'theme-light' },
          {
            value: 'system',
            label: <OptionLabel icon={Monitor} text="跟随系统" />,
            testId: 'theme-system'
          },
          { value: 'dark', label: <OptionLabel icon={Moon} text="深色" />, testId: 'theme-dark' }
        ]}
      />
    </div>
  )
}
