import type { JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import type { VolumeInfo } from '@shared/disk'
import { formatBytes } from '@shared/format'

interface Props {
  volumes: VolumeInfo[]
  onRefresh: () => void
}

/** 左侧分区列表：每个盘一条占用横条（低于 10GB 剩余转琥珀） */
export function PartitionList({ volumes, onRefresh }: Props): JSX.Element {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[13px] font-semibold">磁盘分区</span>
        <button
          type="button"
          onClick={onRefresh}
          title="刷新分区信息"
          className="cursor-pointer rounded p-1 text-dim transition-colors duration-150 hover:bg-panel-2 hover:text-fg"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-auto px-4 pb-4">
        {volumes.length === 0 && <div className="text-[11px] text-dim">读取中…</div>}
        {volumes.map((volume) => {
          const percent = volume.total > 0 ? Math.round((volume.used / volume.total) * 100) : 0
          const low = volume.free < 10 * 1024 ** 3
          return (
            <div key={volume.name} data-testid="volume-row">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[12px] font-medium">{volume.name}</span>
                <span className="font-mono text-[10px] text-dim">{percent}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2">
                <div
                  className={`h-full rounded-full ${low ? 'bg-warn' : 'bg-signal'}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="mt-1 text-[10px] text-dim">
                剩余 {formatBytes(volume.free)} / 共 {formatBytes(volume.total)}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
