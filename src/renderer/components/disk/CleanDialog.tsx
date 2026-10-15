import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Lock } from 'lucide-react'
import type { CleanFailure, CleanHolder, CleanRequestItem, CleanResult } from '@shared/disk'
import { formatBytes } from '@shared/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Rocker } from '@/components/instrument/rocker'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  items: CleanRequestItem[]
  onOpenChange: (open: boolean) => void
  onDone: (result: CleanResult) => void
}

/** 「厂商|PID」之外的进程名一律原样显示；空名兜底成「未知程序」 */
function holderLabel(holder: CleanHolder): string {
  return `${holder.name || '未知程序'}（PID ${holder.pid}）`
}

/** 按原因给出可执行的下一步，而不是把返回码丢给用户 */
function adviceFor(failure: CleanFailure['reason']): string {
  if (failure === 'recycle-cancelled') {
    return '回收站模式对整项会放弃（Windows 的 FOF_ALLOWUNDO 遇到被占文件就整体取消）。上面列出的进程关掉后重新清理即可清掉剩余部分；若确实不需要还原，也可以改用「永久删除」。'
  }
  if (failure === 'locked') {
    return '这些文件正被上面的程序占用。关闭它们（或从托盘退出）后重新清理即可；剩余部分不会被强行删除。'
  }
  if (failure === 'denied') {
    return '需要管理员权限，或目标被系统保护。'
  }
  return '可稍后重试；若持续失败，请在资源管理器里手动查看该路径。'
}

/**
 * 清理确认：讲清「删什么、多少、去哪」；永久删除是独立档位，选中后给出后果说明。
 *
 * 清理完成后**不再直接关窗**：只要还有没删干净的项，就把结果留在对话框里
 * —— 哪一项、删掉了多少、还剩多少、被哪个进程占着，都要看得见。
 * 早期版本只弹一句「N 项失败（文件正被占用）」，用户既不知道是哪个进程，
 * 也不知道原来被占的只是几个小文件、整批都被这一句给带过去了。
 */
export function CleanDialog({ open, items, onOpenChange, onDone }: Props): JSX.Element {
  const [permanent, setPermanent] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CleanResult | null>(null)
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0)

  const reset = (): void => {
    setResult(null)
    setPermanent(false)
  }

  const run = async (): Promise<void> => {
    setRunning(true)
    try {
      const outcome = await window.opsCabin.runClean(items, permanent ? 'permanent' : 'recycle')
      if (!outcome.ok) {
        toast.error(outcome.error)
        return
      }
      const { result: cleaned } = outcome
      // 成功项立刻从列表里摘掉；失败项继续留在列表中（onDone 只收到 removed）
      onDone(cleaned)
      if (cleaned.failed.length === 0) {
        toast.success(`已释放 ${formatBytes(cleaned.freedBytes)}（${cleaned.succeeded} 项）`)
        onOpenChange(false)
        reset()
        return
      }
      if (cleaned.succeeded > 0 || cleaned.freedBytes > 0) {
        toast.warning(
          `释放 ${formatBytes(cleaned.freedBytes)}；${cleaned.failed.length} 项没删干净，仍留在列表中`
        )
      } else {
        toast.error(`清理未成功：${cleaned.failed.length} 项没删成`)
      }
      // 留在窗里看明细
      setResult(cleaned)
    } finally {
      setRunning(false)
    }
  }

  const summaryBytes = result ? formatBytes(result.freedBytes) : formatBytes(totalBytes)

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!running) {
          if (!next) reset()
          onOpenChange(next)
        }
      }}
    >
      <AlertDialogContent data-testid="clean-dialog" className="border-line-2 shadow-none">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[14px] font-bold tracking-[0.01em]">
            {result ? '清理结果' : `清理 ${items.length} 项`}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[12px] leading-relaxed">
            {result ? (
              <>
                已释放 <span className="num font-semibold text-fg">{summaryBytes}</span>
                {result.succeeded > 0 && `（${result.succeeded} 项整项删掉）`}
                {result.failed.length > 0 && `；${result.failed.length} 项没删干净，已留在列表中`}
              </>
            ) : (
              <>
                预计释放 <span className="num font-semibold text-fg">{summaryBytes}</span>
                {permanent ? '。永久删除不进回收站，无法恢复。' : '。删除进回收站，之后可以还原。'}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {result ? (
          <ul
            className="max-h-[320px] overflow-auto rounded-md border border-line"
            data-testid="clean-result-list"
          >
            {result.failed.map((failure) => (
              <li
                key={failure.path}
                className="border-b border-line px-2.5 py-2 text-[11.5px] last:border-b-0"
                data-testid="clean-failed-item"
              >
                <div className="flex items-baseline gap-2">
                  <Lock className="size-3 shrink-0 translate-y-0.5 text-warn" />
                  <span className="num min-w-0 flex-1 truncate" title={failure.path}>
                    {failure.path}
                  </span>
                  {typeof failure.residueBytes === 'number' && failure.residueBytes > 0 && (
                    <span className="num shrink-0 text-dim">
                      剩 {formatBytes(failure.residueBytes)}
                      {failure.residueFiles ? ` / ${failure.residueFiles} 个文件` : ''}
                    </span>
                  )}
                </div>

                <p className="mt-1 pl-5 leading-relaxed text-dim">{failure.error}</p>

                {failure.holders && failure.holders.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1 pl-5" data-testid="clean-holders">
                    {failure.holders.map((holder) => (
                      <span
                        key={holder.pid}
                        className="chip-danger num rounded border px-1.5 py-0.5 text-[11px]"
                      >
                        {holderLabel(holder)}
                      </span>
                    ))}
                  </div>
                )}

                {failure.samples && failure.samples.length > 0 && (
                  <p className="num mt-1 pl-5 text-[10.5px] leading-relaxed text-dim/80">
                    被占文件：
                    {failure.samples
                      .slice(0, 3)
                      .map((sample) => sample.split(/[\\/]/).pop() ?? sample)
                      .join('、 ')}
                    {failure.samples.length > 3 ? ` 等 ${failure.samples.length} 个` : ''}
                  </p>
                )}

                <p className="mt-1 pl-5 text-[10.5px] leading-relaxed text-dim">
                  {adviceFor(failure.reason)}
                </p>

                {typeof failure.deletedBytes === 'number' && failure.deletedBytes > 0 && (
                  <p className="num mt-1 pl-5 text-[10.5px] text-dim">
                    这一项已删掉 {formatBytes(failure.deletedBytes)}，剩余部分保留。
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="max-h-[240px] overflow-auto rounded-md border border-line">
            {items.map((item) => (
              <li
                key={item.path}
                className="flex items-baseline gap-3 border-b border-line px-2.5 py-1.5 text-[11.5px] last:border-b-0"
              >
                <span className="num min-w-0 flex-1 truncate text-dim" title={item.path}>
                  {item.path}
                </span>
                <span className="num shrink-0">{formatBytes(item.bytes)}</span>
              </li>
            ))}
          </ul>
        )}

        {!result && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Rocker
              aria-label="清理方式"
              size="sm"
              value={permanent ? 'permanent' : 'recycle'}
              onChange={(value) => setPermanent(value === 'permanent')}
              className={cn(running && 'pointer-events-none opacity-45')}
              options={[
                { value: 'recycle', label: '删除到回收站' },
                { value: 'permanent', label: '永久删除' }
              ]}
            />
            <span className="text-[11px] text-dim">
              {permanent ? '不进回收站，文件立即消失' : '可以从回收站还原'}
            </span>
          </div>
        )}

        {!result && permanent && (
          <div className="chip-danger flex items-start gap-2 rounded-md border p-2 text-[11.5px] leading-relaxed">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>永久删除不可撤销：这些文件不会进回收站，删掉就找不回来了。</span>
          </div>
        )}

        <AlertDialogFooter>
          {result ? (
            <AlertDialogCancel data-testid="clean-result-close">知道了</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel disabled={running}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={running}
                variant={permanent ? 'destructive' : 'default'}
                data-testid="clean-confirm"
                onClick={(event) => {
                  event.preventDefault()
                  void run()
                }}
              >
                {running ? '清理中…' : permanent ? '永久删除' : '清理到回收站'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
