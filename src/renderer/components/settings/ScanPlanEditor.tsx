import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import type { ScanPlan } from '@shared/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  plan: ScanPlan
  onChange: (plan: ScanPlan) => void
}

const MODES: { mode: ScanPlan['mode']; label: string }[] = [
  { mode: 'manual', label: '手动' },
  { mode: 'daily', label: '每天' },
  { mode: 'weekly', label: '每周（周一）' }
]

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** 清理计划：手动 / 每天 / 每周（周一）；时刻失焦或回车时落盘，错误就近提示 */
export function ScanPlanEditor({ plan, onChange }: Props): JSX.Element {
  const [timeDraft, setTimeDraft] = useState(plan.time)
  const [error, setError] = useState<string | null>(null)

  const commitTime = (): void => {
    if (!TIME_PATTERN.test(timeDraft)) {
      setError('时间格式需要 HH:mm（例如 09:30）')
      return
    }
    setError(null)
    if (timeDraft !== plan.time) onChange({ ...plan, time: timeDraft })
  }

  const checkNow = async (): Promise<void> => {
    const fired = await window.opsCabin.checkScanPlanNow()
    if (fired) toast.success('已触发一次计划扫描（完成后会发通知）')
    else toast('未触发：计划为「手动」、未到点或任务正在运行')
  }

  return (
    <div className="space-y-3" data-testid="scan-plan-editor">
      <div className="flex w-fit items-center gap-0.5 rounded-lg bg-panel-2 p-1">
        {MODES.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            data-testid={`plan-${mode}`}
            aria-pressed={plan.mode === mode}
            onClick={() => onChange({ ...plan, mode })}
            className={cn(
              'cursor-pointer rounded-md px-3 py-1.5 text-[12px] transition-colors duration-150',
              plan.mode === mode
                ? 'bg-panel font-medium text-fg shadow-sm'
                : 'text-dim hover:text-fg'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {plan.mode !== 'manual' && (
        <div className="flex items-start gap-3">
          <div>
            <label htmlFor="plan-time" className="mb-1 block text-[11px] text-dim">
              触发时刻
            </label>
            <input
              id="plan-time"
              data-testid="plan-time"
              value={timeDraft}
              onChange={(event) => setTimeDraft(event.target.value)}
              onBlur={commitTime}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitTime()
              }}
              placeholder="09:30"
              className="w-24 rounded-md border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] outline-none transition-colors duration-150 placeholder:text-dim focus-visible:border-signal"
            />
            {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-5"
            data-testid="plan-check-now"
            onClick={() => void checkNow()}
          >
            立即检查一次
          </Button>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-dim">
        计划触发「安全清理 + 开发缓存」扫描（只扫不删），完成后发系统通知；
        关掉应用期间错过的计划会在启动时补扫。
      </p>
    </div>
  )
}
