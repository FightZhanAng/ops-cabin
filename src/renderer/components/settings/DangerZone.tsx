import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { Bay } from '@/components/instrument/plate'
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

/** 危险动作的行内按钮：透明底 + 红描边，hover 才上红 —— 实底红留给确认按钮 */
const DANGER_BUTTON = 'shrink-0 border-danger/45 text-danger hover:bg-danger/10'

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
    <Bay
      eyebrow="DANGER"
      title="危险区"
      hint="这里的动作不可撤销，都会先向你确认一次。"
      className="border-l-2 border-l-danger-soft"
      pad="none"
      bodyClassName="pt-1"
      data-testid="danger-zone"
    >
      <div className="flex min-h-[38px] items-center justify-between gap-4 border-b border-line px-3.5 py-1.5">
        <div className="min-w-0">
          <div className="text-[12.5px]">清空变化记录</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-dim">
            删除全部关注端口的变化历史（不影响关注清单）。
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className={DANGER_BUTTON}
          data-testid="danger-clear-events"
          onClick={() => setConfirm('clear-events')}
        >
          清空
        </Button>
      </div>

      <div className="flex min-h-[38px] items-center justify-between gap-4 px-3.5 py-1.5">
        <div className="min-w-0">
          <div className="text-[12.5px]">重置全部设置</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-dim">
            主题 / 通知 / 白名单 / 清理计划恢复默认（保留窗口位置）。
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className={DANGER_BUTTON}
          data-testid="danger-reset"
          onClick={() => setConfirm('reset')}
        >
          重置
        </Button>
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !running) setConfirm(null)
        }}
      >
        <AlertDialogContent data-testid="danger-confirm">
          <AlertDialogHeader>
            <div className="eyebrow text-faint">DANGER · CONFIRM</div>
            <AlertDialogTitle>
              {confirm === 'reset' ? '重置全部设置' : '清空变化记录'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'reset'
                ? '将把主题、通知开关、白名单与清理计划恢复默认值（窗口位置保留）。此操作不可撤销。'
                : '将删除全部关注端口的变化历史。此操作不可撤销。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="danger-confirm-btn"
              disabled={running}
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
    </Bay>
  )
}
