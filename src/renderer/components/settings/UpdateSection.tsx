import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UpdateState } from '@shared/update'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

interface Props {
  autoCheck: boolean
  onAutoCheckChange: (value: boolean) => void
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
    <div className="space-y-3 text-[12px]" data-testid="update-section">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div>
            当前版本 <span className="font-mono text-[11px]">{state?.current ?? '…'}</span>
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
            variant="outline"
            data-testid="update-release-page"
            onClick={() => void window.opsCabin.openReleasePage()}
          >
            发布页
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line pt-3">
        <div>
          <div>每天自动检查一次新版本</div>
          <div className="text-[11px] text-dim">只检查并提示；下载与安装始终由你手动触发。</div>
        </div>
        <Switch
          checked={autoCheck}
          onCheckedChange={onAutoCheckChange}
          data-testid="auto-update-switch"
          className="cursor-pointer"
        />
      </div>
    </div>
  )
}
