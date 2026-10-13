import type { ComponentProps, JSX } from 'react'
import { cn } from 'cn'

export interface StatCell {
  label: string
  /** 已格式化好的读数（数字一律走 .num，等宽才不会让整行跟着抖） */
  value: string
  /**
   * 读数需要留意时染色。
   *
   * 只有真的有问题才染 —— 「正常」不映射成绿色，走中性色（见设计系统：
   * 颜色是信号不是装饰）。
   */
  danger?: boolean
}

const COLUMNS: Record<2 | 3 | 4, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4'
}

/**
 * 一排读数格。
 *
 * 格子之间用 1px 发丝线拼合（与 Plate / Bay 同一套观感），是「一块面板切出的格」，
 * 不是几个漂浮的小卡片 —— 四个圆角卡片各带一圈阴影会把读数拆散。
 *
 * 其余属性透传到根节点，用来挂 e2e 契约（data-testid / data-total / …）。
 */
export function StatGrid({
  cells,
  columns = 4,
  className,
  ...rest
}: {
  cells: readonly StatCell[]
  columns?: 2 | 3 | 4
} & Omit<ComponentProps<'div'>, 'children'>): JSX.Element {
  return (
    <div
      {...rest}
      className={cn(
        'grid gap-px overflow-hidden rounded-md border border-line bg-line',
        COLUMNS[columns],
        className
      )}
    >
      {cells.map((cell) => (
        <div key={cell.label} className="bg-panel px-3 py-2">
          <div className="eyebrow text-faint">{cell.label}</div>
          <div
            className={cn(
              'num pb-0.5 text-[15px] font-bold',
              cell.danger === true && 'text-warn'
            )}
          >
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  )
}
