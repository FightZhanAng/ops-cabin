import type { JSX } from 'react'
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

/*
 * 删除登记的二次确认框 —— 启动项页与计划任务页共用。
 *
 * 文案口径固定（不可撤销 / 只删登记不碰程序本体），两页不许各写各的；
 * running 期间锁住关闭途径（取消 / Esc / 点遮罩），防止对话框关掉但请求还在飞。
 */
export function DeleteConfirmDialog({
  open,
  running,
  title,
  detail,
  testId,
  onCancel,
  onConfirm
}: {
  open: boolean
  running: boolean
  title: string
  /** 说明句：由调用方拼好（两页的对象不同，措辞同口径） */
  detail: string
  /** 确认框根节点 testid；确认按钮自动派生 `${testId}-btn` */
  testId: string
  /** 对话框被关掉（取消 / Esc / 点遮罩）；running 时不会触发 */
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) onCancel()
      }}
    >
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <div className="eyebrow text-faint">DELETE · CONFIRM</div>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{detail}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid={`${testId}-btn`}
            disabled={running}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {running ? '删除中…' : '删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
