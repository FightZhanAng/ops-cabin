import { useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import type { PortEntry } from '@shared/ports'
import { formatBytes, formatClock, formatDuration } from '@shared/format'
import { Lamp } from '@/components/instrument/lamp'
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
import { Badge } from '@/components/ui/badge'
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

/** 一格读数：微标签 + 等宽数字 */
function Readout({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="eyebrow text-faint">{label}</div>
      <div className="num mt-0.5 truncate text-[12.5px]" title={value}>
        {value}
      </div>
    </div>
  )
}

/** 进程详情：端口/地址、进程读数、命令行，以及危险的「结束进程」 */
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
              <DialogHeader className="gap-1.5">
                <div className="eyebrow text-faint">PORT · PROCESS</div>
                <DialogTitle className="flex items-center gap-2">
                  <span className="num text-[24px] font-bold leading-none">{entry.port}</span>
                  <Badge variant="outline" className="uppercase">
                    {entry.protocol}
                  </Badge>
                  <span className="flex items-center gap-1.5 text-[12px] font-normal text-ok">
                    <Lamp state="ok" size={7} label="占用中" />
                    占用中
                  </span>
                </DialogTitle>
                <DialogDescription className="num text-[11px]">
                  {entry.addresses.join('  ')}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <div className="min-w-0">
                  <div className="eyebrow text-faint">PROCESS</div>
                  <div className="mt-0.5 truncate text-[13px]" title={entry.processName ?? ''}>
                    {entry.processName ?? '未知进程'}
                  </div>
                  {entry.processPath && (
                    <div className="num mt-0.5 break-all text-[11px] leading-relaxed text-dim">
                      {entry.processPath}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-sm border border-line bg-panel-2 p-2.5">
                  <Readout label="PID" value={String(entry.pid)} />
                  <Readout
                    label="内存"
                    value={entry.memoryBytes !== null ? formatBytes(entry.memoryBytes) : '—'}
                  />
                  <Readout
                    label="运行时长"
                    value={entry.startedAt ? formatDuration(Date.now() - entry.startedAt) : '—'}
                  />
                  <Readout
                    label="启动时间"
                    value={entry.startedAt ? formatClock(entry.startedAt) : '—'}
                  />
                </div>

                {entry.commandLine && (
                  <div>
                    <div className="eyebrow text-faint">命令行</div>
                    <pre className="num mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-panel-2 p-2 text-[10.5px] leading-relaxed text-dim">
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
                    variant="ghost"
                    onClick={() => void window.opsCabin.showInFolder(entry.processPath as string)}
                  >
                    打开所在目录
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="kill-open"
                  className="ml-auto"
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
            <div className="eyebrow text-faint">KILL · CONFIRM</div>
            <AlertDialogTitle className="text-[14px] font-bold">结束进程</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px] leading-relaxed text-dim">
              结束 {entry?.processName ?? '进程'}（PID {entry?.pid}）？未保存的数据可能丢失；
              若优雅关闭失败将强制结束。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={killing}>取消</AlertDialogCancel>
            <AlertDialogAction
              data-testid="kill-confirm"
              variant="destructive"
              disabled={killing}
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
