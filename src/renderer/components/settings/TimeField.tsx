import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { TIME_PATTERN } from '@shared/notify'
import { cn } from '@/lib/utils'

/** 时刻输入的统一外观（同一个 HH:mm 不该在设置页的两处长得不一样） */
export const TIME_INPUT_CLASS =
  'num h-7 w-20 rounded-sm border border-line-2 bg-panel-2 px-2 text-[12px] text-fg outline-none transition-colors duration-150 placeholder:text-faint focus-visible:border-fg'

interface Props {
  id: string
  value: string
  onCommit: (value: string) => void
  /** 无障碍名 */
  label: string
  testId?: string
  placeholder?: string
  className?: string
}

/**
 * HH:mm 时刻输入：失焦或回车时提交，格式不对就近提示且**不落盘**。
 *
 * 抽成组件是因为设置页有两处（清理计划的触发时刻、安静时段的起止）——
 * 校验规则、提交时机、错误提示的位置必须一模一样；各写一份就是两次将来不一致的机会，
 * 而「时间存进去了但没生效」是这里最难查的一类问题。
 */
export function TimeField({
  id,
  value,
  onCommit,
  label,
  testId,
  placeholder = '09:30',
  className
}: Props): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)

  // 外部值变了（重置设置、别处改了同一字段）时跟上，否则输入框会留在旧草稿上
  useEffect(() => {
    setDraft(value)
    setError(null)
  }, [value])

  const commit = (): void => {
    if (!TIME_PATTERN.test(draft)) {
      setError('格式需要 HH:mm')
      return
    }
    setError(null)
    if (draft !== value) onCommit(draft)
  }

  return (
    <div className={cn('min-w-0', className)}>
      <input
        id={id}
        data-testid={testId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
        placeholder={placeholder}
        aria-label={label}
        className={TIME_INPUT_CLASS}
      />
      {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
    </div>
  )
}
