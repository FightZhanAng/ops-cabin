import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UpdateState } from '@shared/update'
import { Lamp } from '@/components/instrument/lamp'
import type { LampState } from '@/components/instrument/lamp'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

interface Props {
  autoCheck: boolean
  onAutoCheckChange: (value: boolean) => void
}

interface StatusMark {
  text: string
  lamp: LampState
  pulse?: boolean
}

/** 更新状态 → 仪表灯 + 文字（颜色永远配文字，色盲也能读） */
function statusMark(status: UpdateState['status'], checkedAt: number): StatusMark {
  switch (status) {
    case 'checking':
      return { text: '正在检查', lamp: 'idle', pulse: true }
    case 'available':
      return { text: '发现新版本', lamp: 'warn' }
    case 'downloading':
      return { text: '正在下载', lamp: 'ink', pulse: true }
    case 'downloaded':
      return { text: '已下载，可以安装', lamp: 'ok' }
    case 'error':
      return { text: '检查失败', lamp: 'danger' }
    case 'unsupported':
      return { text: '不支持自动更新', lamp: 'idle' }
    default:
      return checkedAt > 0
        ? { text: '已是最新', lamp: 'ok' }
        : { text: '尚未检查', lamp: 'idle' }
  }
}

/** 软件更新：检查 / 下载 / 安装三段分开，安装永远由用户点 */
export function UpdateSection({ autoCheck, onAutoCheckChange }: Props): JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.opsCabin.getUpdate().then((s) => {
      if (alive) setState(s)
    })
    const off = window.opsCabin.onUpdate((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const status = state?.status ?? 'idle'
  const mark = statusMark(status, state?.checkedAt ?? 0)

  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.opsCabin.checkUpdate()
      if (next) setState(next)
    } finally {
      setBusy(false)
    }
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.opsCabin.downloadUpdate()
      if (next) setState(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="update-section">
      <div className="flex min-h-[38px] items-start justify-between gap-4 border-b border-line px-3.5 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Lamp state={mark.lamp} pulse={mark.pulse} />
            <span className="text-[12.5px]">{mark.text}</span>
            <span className="num text-[11.5px] text-dim">v{state?.current ?? '…'}</span>
          </div>
          {state?.message && (
            <div
              className="mt-0.5 text-[11px] leading-relaxed text-dim"
              data-testid="update-message"
            >
              {state.message}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {status === 'downloaded' ? (
            <Button
              size="sm"
              data-testid="update-install"
              onClick={() => void window.opsCabin.installUpdate()}
            >
              重启并安装
            </Button>
          ) : status === 'available' ? (
            <Button size="sm" data-testid="update-download" disabled={busy} onClick={() => void download()}>
              下载 {state?.latest}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              data-testid="update-check"
              disabled={busy || status === 'checking' || status === 'downloading' || status === 'unsupported'}
              onClick={() => void check()}
            >
              {status === 'checking' ? '检查中…' : '检查更新'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            data-testid="update-release-page"
            onClick={() => void window.opsCabin.openReleasePage()}
          >
            发布页
          </Button>
        </div>
      </div>

      <div className="flex min-h-[38px] items-center justify-between gap-4 px-3.5 py-2">
        <div className="min-w-0">
          <div className="text-[12.5px]">每天自动检查一次新版本</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-dim">
            只检查并提示；下载与安装始终由你手动触发。
          </div>
        </div>
        <Switch
          checked={autoCheck}
          onCheckedChange={onAutoCheckChange}
          data-testid="auto-update-switch"
        />
      </div>
    </div>
  )
}
