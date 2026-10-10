import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
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
import { Checkbox } from '@/components/ui/checkbox'

interface Props {
  open: boolean
  items: CleanRequestItem[]
  onOpenChange: (open: boolean) => void
  onDone: (result: CleanResult) => void
}

/** 清理确认：讲清「删什么、多少、去哪」，永久删除是独立选项且文案更强 */
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
      <AlertDialogContent data-testid="clean-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>清理 {items.length} 项</AlertDialogTitle>
          <AlertDialogDescription className="text-[12px] leading-relaxed">
            预计释放{' '}
            <span className="font-mono font-semibold text-fg">{formatBytes(totalBytes)}</span>。
            {permanent ? '永久删除 —— 不进回收站，无法恢复。' : '删除进回收站，之后可以还原。'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-[12px]">
          <Checkbox
            checked={permanent}
            disabled={running}
            onCheckedChange={(value) => setPermanent(value === true)}
          />
          永久删除（不进回收站）
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={running} className="cursor-pointer">
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={running}
            data-testid="clean-confirm"
            className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
