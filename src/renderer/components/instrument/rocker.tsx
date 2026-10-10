import type { JSX, ReactNode } from 'react'
import { cn } from 'cn'

export interface RockerOption<T extends string> {
  value: T
  label: ReactNode
  /** 透传给该档位按钮（e2e 契约用） */
  testId?: string
  title?: string
}

interface Props<T extends string> {
  options: ReadonlyArray<RockerOption<T>>
  value: T
  onChange: (value: T) => void
  'aria-label'?: string
  size?: 'sm' | 'md'
  className?: string
}

/** 拨档开关：仪器面板上的多档拨档（主题 / 协议筛选 / 计划模式共用） */
export function Rocker<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  ...rest
}: Props<T>): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={rest['aria-label']}
      className={cn(
        'inline-flex shrink-0 items-center gap-px rounded-md border border-line-2 bg-panel-2 p-px',
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            className={cn(
              'cursor-pointer rounded-sm px-2.5 font-medium whitespace-nowrap transition-colors duration-150',
              size === 'sm' ? 'h-[22px] text-[11.5px]' : 'h-[26px] text-[12px]',
              active
                ? 'bg-panel text-fg shadow-[inset_0_0_0_1px_var(--line-2)]'
                : 'text-dim hover:text-fg'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
