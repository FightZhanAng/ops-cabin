import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import type { ScanPlan } from '@shared/types'
import { Rocker } from '@/components/instrument/rocker'
import { Button } from '@/components/ui/button'

interface Props {
  plan: ScanPlan
  onChange: (plan: ScanPlan) => void
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

const INPUT_CLASS =
  'num h-7 w-20 rounded-sm border border-line-2 bg-panel-2 px-2 text-[12px] text-fg outline-none transition-colors duration-150 placeholder:text-faint focus-visible:border-fg'

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
    <div data-testid="scan-plan-editor">
      <div className="flex min-h-[38px] items-center justify-between gap-4 px-3.5">
        <span className="text-[12.5px]">扫描频率</span>
        <Rocker
          aria-label="扫描频率"
          value={plan.mode}
          onChange={(mode) => onChange({ ...plan, mode })}
          options={[
            { value: 'manual', label: '手动', testId: 'plan-manual' },
            { value: 'daily', label: '每天', testId: 'plan-daily' },
            { value: 'weekly', label: '每周（周一）', testId: 'plan-weekly' }
          ]}
        />
      </div>

      {plan.mode !== 'manual' && (
        <div className="flex min-h-[38px] items-center justify-between gap-4 border-t border-line px-3.5 py-1.5">
          <label htmlFor="plan-time" className="text-[12.5px]">
            触发时刻
          </label>
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0">
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
                aria-label="触发时刻（HH:mm）"
                className={INPUT_CLASS}
              />
              {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
            </div>
            <Button
              size="sm"
              variant="outline"
              data-testid="plan-check-now"
              onClick={() => void checkNow()}
            >
              立即检查一次
            </Button>
          </div>
        </div>
      )}

      <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-dim">
        计划触发「安全清理 + 开发缓存」扫描（只扫不删），完成后发系统通知；
        关掉应用期间错过的计划会在启动时补扫。
      </p>
    </div>
  )
}
