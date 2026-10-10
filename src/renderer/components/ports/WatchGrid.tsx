import type { JSX } from 'react'
import { Plus, X } from 'lucide-react'
import type { PortEntry, WatchItem } from '@shared/ports'
import { formatDuration } from '@shared/format'
import { cn } from '@/lib/utils'

interface Props {
  watchlist: WatchItem[]
  entries: PortEntry[]
  onOpen: (entry: PortEntry) => void
  onRemove: (port: number) => void
  onAdd: () => void
}

/** 关注端口卡片阵 —— 端口雷达的签名视觉：端口号等宽大字 + 状态灯 + 占用进程 */
export function WatchGrid({ watchlist, entries, onOpen, onRemove, onAdd }: Props): JSX.Element {
  const byPort = new Map<number, PortEntry>()
  for (const entry of entries) {
    if (!byPort.has(entry.port)) byPort.set(entry.port, entry)
  }

  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2"
      data-testid="watch-grid"
    >
      {watchlist.map((item) => {
        const entry = byPort.get(item.port)
        const occupied = entry !== undefined
        return (
          <div
            key={item.port}
            data-testid="watch-card"
            data-port={item.port}
            data-occupied={occupied ? 'true' : 'false'}
            className={cn(
              'group relative rounded-[10px] border border-line bg-panel p-3 transition-colors duration-150',
              occupied && 'cursor-pointer hover:border-signal/40'
            )}
            onClick={() => {
              if (entry) onOpen(entry)
            }}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[20px] font-semibold leading-none tabular-nums">
                {item.port}
              </span>
              <span
                aria-hidden
                className={cn(
                  'size-2 rounded-full',
                  occupied ? 'bg-signal' : 'border border-dim'
                )}
              />
              <span className="text-[10px] text-dim">{occupied ? '占用中' : '空闲'}</span>
              <button
                type="button"
                title="取消关注"
                data-testid="watch-remove"
                className="ml-auto cursor-pointer rounded p-0.5 text-dim opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-danger"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(item.port)
                }}
              >
                <X className="size-3" />
              </button>
            </div>

            <div className="mt-1.5 truncate text-[11px] text-dim" title={item.label}>
              {item.label}
            </div>

            {occupied && entry && (
              <div
                className="mt-0.5 truncate font-mono text-[10px] text-dim"
                title={entry.processName ?? ''}
              >
                {entry.processName ?? '未知进程'} · 已运行{' '}
                {entry.startedAt ? formatDuration(Date.now() - entry.startedAt) : '—'}
              </div>
            )}
          </div>
        )
      })}

      <button
        type="button"
        data-testid="watch-add"
        onClick={onAdd}
        className="flex min-h-[76px] cursor-pointer flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-line text-dim transition-colors duration-150 hover:border-signal/40 hover:text-fg"
      >
        <Plus className="size-4" />
        <span className="text-[11px]">关注端口</span>
      </button>
    </div>
  )
}
