import type { JSX } from 'react'
import { ExternalLink } from 'lucide-react'
import type { AppInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

/*
 * 「关于」弹窗：版本号 + 运行时 + GitHub 项目主页快捷入口。
 * 从标题栏的关于菜单里点「版本」打开（菜单只留操作项，细节都收在这里）。
 */

interface Props {
  info: AppInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** GitHub 官方 mark（Lucide 1.x 已移除品牌图标，这里内联，跟文字同色） */
function GitHubMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

/** 运行时行：标签在左，读数值在右（成列右对齐） */
function RuntimeRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 text-[11.5px]">
      <span className="text-dim">{label}</span>
      <span className="num text-fg">{value}</span>
    </div>
  )
}

export function AboutDialog({ info, open, onOpenChange }: Props): JSX.Element {
  const repoLabel = (info?.repo ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="about-dialog" className="max-w-[400px]">
        <DialogHeader className="gap-1.5">
          <span className="eyebrow text-faint">ABOUT</span>
          <DialogTitle>{info?.name ?? '运维舱'}</DialogTitle>
          <DialogDescription className="num text-[12px]">
            版本 <span data-testid="about-dialog-version">v{info?.version ?? '…'}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 border-t border-line pt-3">
          <RuntimeRow label="Electron" value={info?.electron ?? '—'} />
          <RuntimeRow label="Chromium" value={info?.chrome ?? '—'} />
          <RuntimeRow label="Node" value={info?.node ?? '—'} />
        </div>

        <div className="border-t border-line pt-3">
          <Button
            size="sm"
            variant="outline"
            data-testid="about-github"
            disabled={!info?.repo}
            className="w-full justify-between"
            onClick={() => {
              if (info?.repo) void window.opsCabin.openExternal(info.repo)
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <GitHubMark className="size-[13px] shrink-0" />
              <span className="num truncate text-[11.5px]">{repoLabel || 'GitHub'}</span>
            </span>
            <ExternalLink className="size-3 shrink-0 text-dim" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
