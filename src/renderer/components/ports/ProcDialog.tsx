import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import type { PortEntry } from '@shared/ports'
import { formatBytes, formatClock, formatDuration } from '@shared/format'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'

interface Props {
  entry: PortEntry | null
  onOpenChange: (open: boolean) => void
  onToggleWatch: (entry: PortEntry) => void
}

/** 进程详情：端口/地址、进程信息、命令行，以及危险的「结束进程」 */
export function ProcDialog({ entry, onOpenChange, onToggleWatch }: Props): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [killing, setKilling] = useState(false)

  const doKill = async (): Promise<void> => {
    if (!entry) return
    setKilling(true)
    try {
      const result = await window.opsCabin.runKill(entry.pid)
      if (result.ok) {
        toast.success(
          `已结束 ${entry.processName ?? '进程'}（PID ${entry.pid}）${result.forced ? '（强制）' : ''}`
        )
        setConfirmOpen(false)
        onOpenChange(false)
      } else {
        toast.error(result.error ?? '结束进程失败')
      }
    } finally {
      setKilling(false)
    }
  }

  return (
    <>
      <Dialog
        open={entry !== null}
        onOpenChange={(open) => {
          if (!open) onOpenChange(false)
        }}
      >
        <DialogContent data-testid="proc-dialog" className="max-w-lg">
          {entry && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-baseline gap-2">
                  <span className="font-mono text-[18px] tabular-nums">端口 {entry.port}</span>
                  <span className="text-[11px] font-normal uppercase text-dim">
                    {entry.protocol}
                  </span>
                </DialogTitle>
                <DialogDescription className="font-mono text-[11px]">
                  {entry.addresses.join('  ')}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 text-[12px]">
                <div className="flex gap-8">
                  <div>
                    <div className="text-[11px] text-dim">进程</div>
                    <div className="mt-0.5">{entry.processName ?? '未知进程'}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-dim">PID</div>
                    <div className="mt-0.5 font-mono tabular-nums">{entry.pid}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-dim">内存</div>
                    <div className="mt-0.5 font-mono tabular-nums">
                      {entry.memoryBytes !== null ? formatBytes(entry.memoryBytes) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-dim">已运行</div>
                    <div className="mt-0.5 font-mono tabular-nums">
                      {entry.startedAt
                        ? `${formatDuration(Date.now() - entry.startedAt)}（${formatClock(entry.startedAt)} 启动）`
                        : '—'}
                    </div>
                  </div>
                </div>

                {entry.processPath && (
                  <div>
                    <div className="text-[11px] text-dim">路径</div>
                    <div className="mt-0.5 break-all font-mono text-[11px] leading-relaxed">
                      {entry.processPath}
                    </div>
                  </div>
                )}

                {entry.commandLine && (
                  <div>
                    <div className="text-[11px] text-dim">命令行</div>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-panel-2 p-2 font-mono text-[10.5px] leading-relaxed text-dim">
                      {entry.commandLine}
                    </pre>
                  </div>
                )}
              </div>

              <Separator />

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="dialog-watch-toggle"
                  onClick={() => onToggleWatch(entry)}
                >
                  {entry.watched ? '取消关注' : '关注这个端口'}
                </Button>
                {entry.processPath && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void window.opsCabin.showInFolder(entry.processPath as string)}
                  >
                    打开所在目录
                  </Button>
                )}
                <Button
                  size="sm"
                  data-testid="kill-open"
                  className="ml-auto cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => setConfirmOpen(true)}
                >
                  结束进程
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>结束进程</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px] leading-relaxed">
              结束 {entry?.processName ?? '进程'}（PID {entry?.pid}）？未保存的数据可能丢失；
              若优雅关闭失败将强制结束。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={killing} className="cursor-pointer">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="kill-confirm"
              disabled={killing}
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void doKill()
              }}
            >
              {killing ? '结束中…' : '结束进程'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
