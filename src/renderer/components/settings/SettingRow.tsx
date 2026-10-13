import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** 设置行：左标签 + 右控件，行间 1px 发丝线（设置页各分组共用） */
export function SettingRow({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-h-[38px] items-center justify-between gap-4 border-b border-line px-3.5 py-1.5 last:border-b-0',
        className
      )}
    >
      <div className="min-w-0">
        <div className="text-[12.5px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-dim">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}
