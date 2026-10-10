import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
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
import { Button } from '@/components/ui/button'

interface Props {
  onResetSettings: () => Promise<void>
}

type ConfirmKind = 'clear-events' | 'reset' | null

/** 危险区：清空变化记录 / 重置全部设置，动作都过二次确认 */
export function DangerZone({ onResetSettings }: Props): JSX.Element {
  const [confirm, setConfirm] = useState<ConfirmKind>(null)
  const [running, setRunning] = useState(false)

  const runConfirmed = async (): Promise<void> => {
    setRunning(true)
    try {
      if (confirm === 'reset') {
        await onResetSettings()
        toast.success('设置已恢复默认（窗口位置保留）')
      } else {
        await window.opsCabin.clearPortEvents()
        toast.success('变化记录已清空')
      }
      setConfirm(null)
    } finally {
      setRunning(false)
    }
  }

  return (
    <section
      className="rounded-[10px] border border-danger/30 bg-panel p-4"
      data-testid="danger-zone"
    >
      <h2 className="text-[13px] font-semibold text-danger">危险区</h2>

      <div className="mt-3 space-y-3 text-[12px]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div>清空变化记录</div>
            <div className="text-[11px] text-dim">
              删除全部关注端口的变化历史（不影响关注清单）。
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 cursor-pointer"
            data-testid="danger-clear-events"
            onClick={() => setConfirm('clear-events')}
          >
            清空
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div>重置全部设置</div>
            <div className="text-[11px] text-dim">
              主题 / 通知 / 白名单 / 清理计划恢复默认（保留窗口位置）。
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 cursor-pointer border-danger/40 text-danger hover:bg-danger/10"
            data-testid="danger-reset"
            onClick={() => setConfirm('reset')}
          >
            重置
          </Button>
        </div>
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !running) setConfirm(null)
        }}
      >
        <AlertDialogContent data-testid="danger-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'reset' ? '重置全部设置' : '清空变化记录'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px] leading-relaxed">
              {confirm === 'reset'
                ? '将把主题、通知开关、白名单与清理计划恢复默认值（窗口位置保留）。此操作不可撤销。'
                : '将删除全部关注端口的变化历史。此操作不可撤销。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running} className="cursor-pointer">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="danger-confirm-btn"
              disabled={running}
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void runConfirmed()
              }}
            >
              {running ? '执行中…' : '确认'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
