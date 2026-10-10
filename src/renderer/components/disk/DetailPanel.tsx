import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { ScanItem } from '@shared/disk'
import { formatBytes, formatCount } from '@shared/format'
import { Button } from '@/components/ui/button'

interface Props {
  item: ScanItem
  onClose: () => void
}

/** 右侧详情面板：选中条目的路径 / 大小 / 风险 / 快捷动作 */
export function DetailPanel({ item, onClose }: Props): JSX.Element {
  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-l border-line bg-panel"
      data-testid="detail-panel"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-[13px] font-semibold">详情</span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="cursor-pointer rounded p-1 text-dim transition-colors duration-150 hover:bg-panel-2 hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-4">
        <div>
          <div className="text-[11px] text-dim">名称</div>
          <div className="mt-0.5 text-[12.5px]">{item.label}</div>
        </div>

        <div>
          <div className="text-[11px] text-dim">路径</div>
          <div className="mt-0.5 break-all font-mono text-[11px] leading-relaxed">{item.path}</div>
        </div>

        <div className="flex gap-8">
          <div>
            <div className="text-[11px] text-dim">大小</div>
            <div className="mt-0.5 font-mono text-[12.5px] tabular-nums">
              {formatBytes(item.bytes)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-dim">文件数</div>
            <div className="mt-0.5 font-mono text-[12.5px] tabular-nums">
              {formatCount(item.files)}
            </div>
          </div>
        </div>

        {item.note && (
          <div className="rounded-md border border-warn/30 bg-warn/10 p-2 text-[11px] leading-relaxed text-warn">
            {item.note}
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => void window.opsCabin.showInFolder(item.path)}
        >
          打开所在目录
        </Button>
      </div>
    </aside>
  )
}
