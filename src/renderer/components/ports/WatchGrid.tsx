import type { JSX } from 'react'
import { Plus, X } from 'lucide-react'
import type { PortEntry, WatchItem } from '@shared/ports'
import { Lamp } from '@/components/instrument/lamp'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  watchlist: WatchItem[]
  entries: PortEntry[]
  onOpen: (entry: PortEntry) => void
  onRemove: (port: number) => void
  onAdd: () => void
}

/** 关注端口卡片阵 —— 端口雷达的读数面：端口号大字 + 状态灯 + 占用进程 */
export function WatchGrid({ watchlist, entries, onOpen, onRemove, onAdd }: Props): JSX.Element {
  const byPort = new Map<number, PortEntry>()
  for (const entry of entries) {
    if (!byPort.has(entry.port)) byPort.set(entry.port, entry)
  }
  const empty = watchlist.length === 0

  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
      data-testid="watch-grid"
    >
      {watchlist.map((item) => {
        const entry = byPort.get(item.port)
        const occupied = entry !== undefined
        const detail = entry
          ? `${entry.processName ?? '未知进程'} · PID ${entry.pid}`
          : '未监听'
        return (
          <div
            key={item.port}
            data-testid="watch-card"
            data-port={item.port}
            data-occupied={occupied ? 'true' : 'false'}
            title={occupied ? '点击查看进程详情' : undefined}
            className={cn(
              'group min-w-0 rounded-md border border-line bg-panel-2 px-2.5 py-2 transition-colors duration-150',
              occupied && 'cursor-pointer hover:border-line-2 hover:bg-sel'
            )}
            onClick={() => {
              if (entry) onOpen(entry)
            }}
          >
            <div className="flex items-center gap-1.5">
              <span className="num text-[18px] font-bold leading-none">{item.port}</span>
              <Lamp state={occupied ? 'ok' : 'idle'} size={7} className="ml-0.5" />
              <span className={cn('text-[11px]', occupied ? 'text-ok' : 'text-dim')}>
                {occupied ? '占用中' : '空闲'}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title="取消关注"
                aria-label={`取消关注端口 ${item.port}`}
                data-testid="watch-remove"
                className="ml-auto opacity-0 transition-opacity duration-150 hover:bg-sel group-hover:opacity-100 focus-visible:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(item.port)
                }}
              >
                <X />
              </Button>
            </div>

            <div className="mt-1.5 truncate text-[13px] leading-snug" title={item.label}>
              {item.label}
            </div>

            <div className="num mt-0.5 truncate text-[10.5px] text-faint" title={detail}>
              {detail}
            </div>
          </div>
        )
      })}

      <button
        type="button"
        data-testid="watch-add"
        onClick={onAdd}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line-2 px-3 text-dim transition-colors duration-150 hover:border-fg/35 hover:bg-panel-2 hover:text-fg',
          empty ? 'col-span-full min-h-[104px]' : 'min-h-[84px]'
        )}
      >
        <Plus className="size-4" />
        <span className="text-[12.5px]">关注端口</span>
        {empty && (
          <span className="max-w-[420px] text-center text-[11px] leading-relaxed text-faint">
            还没有关注任何端口 —— 常用的开发端口加进来，被占用时就会亮灯并推送通知。
          </span>
        )}
      </button>
    </div>
  )
}
