import type { JSX } from 'react'
import { AlertTriangle, FolderOpen, ShieldCheck, X } from 'lucide-react'
import type { ScanItem } from '@shared/disk'
import { formatBytes, formatCount } from '@shared/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface Props {
  item: ScanItem
  onClose: () => void
}

/** 右侧详情面板（264px）：读数 + 路径凹槽 + 定位动作；打开即代表当前焦点条目 */
export function DetailPanel({ item, onClose }: Props): JSX.Element {
  const careful = item.risk === 'careful'
  return (
    <aside
      className="flex w-[264px] shrink-0 flex-col border-l border-line bg-panel"
      data-testid="detail-panel"
    >
      <header className="flex items-start gap-2 border-b border-line pb-2.5 pl-3.5 pr-1.5 pt-3">
        <div className="min-w-0 flex-1">
          <div className="eyebrow text-faint">FILE</div>
          <h2 className="truncate text-[13px] font-semibold leading-snug" title={item.label}>
            {item.label}
          </h2>
        </div>
        <Button size="icon-xs" variant="ghost" onClick={onClose} title="关闭" aria-label="关闭">
          <X />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {careful ? (
            <Badge variant="warn">
              <AlertTriangle />
              谨慎
            </Badge>
          ) : (
            <Badge variant="ok">
              <ShieldCheck />
              安全
            </Badge>
          )}
          <span className="text-[11px] leading-relaxed text-dim">
            {careful ? '清理成本较高，先确认它没有再用' : '删除后可由系统或工具重建'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-dim">大小</div>
            <div className="num text-[13px]">{formatBytes(item.bytes)}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-dim">文件数</div>
            <div className="num text-[13px]">{formatCount(item.files)}</div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="pb-1 text-[11px] text-dim">路径</div>
          <div className="num max-h-[128px] select-text overflow-auto break-all rounded-md border border-line bg-panel-2 p-2 text-[11px] leading-relaxed">
            {item.path}
          </div>
        </div>

        {item.note && (
          <div className="chip-warn rounded-md border p-2 text-[11px] leading-relaxed">
            {item.note}
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          className="mt-auto w-full"
          onClick={() => void window.opsCabin.showInFolder(item.path)}
        >
          <FolderOpen />
          打开所在目录
        </Button>
      </div>
    </aside>
  )
}
