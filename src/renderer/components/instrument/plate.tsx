import type { ComponentProps, JSX, ReactNode } from 'react'
import { cn } from 'cn'

/** 整块仪表板：bay 与 bay 之间由 1px 发丝线分隔（是「一块面板切出的格」，不是漂浮卡片） */
export function Plate({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('grid gap-px overflow-hidden rounded-lg border border-line-2 bg-line', className)}>
      {children}
    </div>
  )
}

interface BayProps extends Omit<ComponentProps<'section'>, 'title' | 'children' | 'onClick'> {
  /** 拉丁微标签（STORAGE / RADAR / SCHEDULE…），说明这一格的职责 */
  eyebrow?: string
  title?: ReactNode
  /** 标题下的一行提示（灰、小字） */
  hint?: ReactNode
  /** 右上角读数或动作 */
  aside?: ReactNode
  /** 原生悬停提示 */
  tooltip?: string
  pad?: 'none' | 'sm' | 'md'
  bodyClassName?: string
  onClick?: () => void
  children: ReactNode
}

/** 面板上的一格（bay）：微标签 + 标题 + 右上读数 + 内容 */
export function Bay({
  eyebrow,
  title,
  hint,
  aside,
  tooltip,
  pad = 'md',
  className,
  bodyClassName,
  onClick,
  children,
  ...rest
}: BayProps): JSX.Element {
  const hasHeader = Boolean(eyebrow || title || aside)
  const padBody = pad === 'none' ? '' : pad === 'sm' ? 'p-2.5' : 'px-3.5 pb-3.5 pt-2.5'

  return (
    <section
      {...rest}
      title={tooltip}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      className={cn(
        'min-w-0 bg-panel',
        onClick && 'cursor-pointer transition-colors duration-150 hover:bg-panel-2',
        className
      )}
    >
      {hasHeader && (
        <header className="flex items-center gap-2 px-3.5 pt-3">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow text-faint">{eyebrow}</div>}
            {title && <h2 className="truncate text-[13px] font-semibold leading-snug">{title}</h2>}
          </div>
          {aside && <div className="ml-auto flex shrink-0 items-center gap-2">{aside}</div>}
        </header>
      )}
      {hint && <p className="px-3.5 pt-1 text-[11px] leading-relaxed text-dim">{hint}</p>}
      <div className={cn(padBody, bodyClassName)}>{children}</div>
    </section>
  )
}
