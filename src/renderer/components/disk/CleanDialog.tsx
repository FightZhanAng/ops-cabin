import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import type { CleanRequestItem, CleanResult } from '@shared/disk'
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

/** 清理确认：讲清「删什么、多少、去哪」；永久删除是独立档位，选中后给出后果说明 */
export function CleanDialog({ open, items, onOpenChange, onDone }: Props): JSX.Element {
  const [permanent, setPermanent] = useState(false)
  const [running, setRunning] = useState(false)
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0)

  const run = async (): Promise<void> => {
    setRunning(true)
    try {
      const outcome = await window.opsCabin.runClean(items, permanent ? 'permanent' : 'recycle')
      if (!outcome.ok) {
        toast.error(outcome.error)
        return
      }
      onOpenChange(false)
      setPermanent(false)
      onDone(outcome.result)
      const { result } = outcome
      if (result.failed.length === 0) {
        toast.success(`已释放 ${formatBytes(result.freedBytes)}（${result.succeeded} 项）`)
      } else if (result.succeeded > 0) {
        toast.warning(
          `释放 ${formatBytes(result.freedBytes)}；${result.failed.length} 项未删成，仍留在列表中`
        )
      } else {
        toast.error(`清理未成功：${result.failed.length} 项失败（${result.failed[0]?.error ?? ''}）`)
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!running) onOpenChange(next)
      }}
    >
      <AlertDialogContent data-testid="clean-dialog" className="border-line-2 shadow-none">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[14px] font-bold tracking-[0.01em]">
            清理 {items.length} 项
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[12px] leading-relaxed">
            预计释放{' '}
            <span className="num font-semibold text-fg">{formatBytes(totalBytes)}</span>
            {permanent ? '。永久删除不进回收站，无法恢复。' : '。删除进回收站，之后可以还原。'}
          </AlertDialogDescription>
        </AlertDialogHeader>

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

        {permanent && (
          <div className="chip-danger flex items-start gap-2 rounded-md border p-2 text-[11.5px] leading-relaxed">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>永久删除不可撤销：这些文件不会进回收站，删掉就找不回来了。</span>
          </div>
        )}

        <AlertDialogFooter>
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
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
