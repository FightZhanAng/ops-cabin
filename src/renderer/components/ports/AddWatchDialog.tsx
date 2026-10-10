import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import type { WatchItem } from '@shared/ports'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  /** 从某一行快捷关注时预填的端口 */
  initialPort: number | null
  onOpenChange: (open: boolean) => void
  onAdded: (items: WatchItem[]) => void
}

/** 常用开发端口：一键填进端口输入框 */
const COMMON_PORTS = [3000, 5173, 4173, 8080] as const

const INPUT_CLASS =
  'h-7 w-full rounded-sm border border-line-2 bg-panel-2 px-2 text-[12px] outline-none transition-colors duration-150 placeholder:text-faint focus-visible:border-fg/40'

/** 添加关注：端口 + 名称 + 备注；校验错误就近提示 */
export function AddWatchDialog({ open, initialPort, onOpenChange, onAdded }: Props): JSX.Element {
  const [port, setPort] = useState('')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setPort(initialPort ? String(initialPort) : '')
      setLabel('')
      setNote('')
      setError(null)
    }
  }, [open, initialPort])

  const submit = async (): Promise<void> => {
    const portNumber = Number(port)
    if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) {
      setError('端口需要是 1-65535 的整数')
      return
    }
    setSaving(true)
    try {
      const items = await window.opsCabin.addWatch({
        port: portNumber,
        label: label.trim() || `端口 ${portNumber}`,
        ...(note.trim() ? { note: note.trim() } : {})
      })
      onAdded(items)
      toast.success(`已关注端口 ${portNumber}`)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent data-testid="add-watch-dialog" className="max-w-md">
        <DialogHeader className="gap-1.5">
          <div className="eyebrow text-faint">WATCH · ADD</div>
          <DialogTitle className="text-[14px] font-bold">关注端口</DialogTitle>
          <DialogDescription className="text-[12px] text-dim">
            关注的端口有变化（被占用 / 释放 / 换主）时会推系统通知，并记入变化记录。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label htmlFor="watch-port" className="eyebrow mb-1 block text-faint">
              端口号
            </label>
            <input
              id="watch-port"
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ''))}
              placeholder="例如 3000"
              data-testid="watch-port-input"
              className={`num text-[13px] ${INPUT_CLASS}`}
            />
            {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="eyebrow text-faint">常用端口</span>
              {COMMON_PORTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPort(String(value))}
                  className="num h-[22px] cursor-pointer rounded-sm border border-line-2 px-2 text-[11px] text-dim transition-colors duration-150 hover:border-fg/35 hover:text-fg"
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="watch-label" className="eyebrow mb-1 block text-faint">
              名称
            </label>
            <input
              id="watch-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="例如 前端开发服务器"
              data-testid="watch-label-input"
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="watch-note" className="eyebrow mb-1 block text-faint">
              备注（可选）
            </label>
            <input
              id="watch-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如 本项目 vite"
              data-testid="watch-note-input"
              className={INPUT_CLASS}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={saving}>
              取消
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={saving}
            data-testid="watch-submit"
            onClick={() => void submit()}
          >
            关注
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
