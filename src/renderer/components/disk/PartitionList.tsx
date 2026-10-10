import type { JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import type { VolumeInfo } from '@shared/disk'
import { formatBytes } from '@shared/format'
import { SegBar, freeTone } from '@/components/instrument/seg-bar'
import { Button } from '@/components/ui/button'

interface Props {
  volumes: VolumeInfo[]
  onRefresh: () => void
}

/** 左轨：每个分区一条分段仪表条 + 剩余读数（剩余 <10GB 转琥珀、<5GB 转红） */
export function PartitionList({ volumes, onRefresh }: Props): JSX.Element {
  return (
    <aside className="flex w-[184px] shrink-0 flex-col border-r border-line bg-panel">
      <header className="flex items-start justify-between gap-1 pb-2.5 pl-3 pr-1.5 pt-3">
        <div className="min-w-0">
          <div className="eyebrow text-faint">VOLUMES</div>
          <h2 className="text-[13px] font-semibold leading-snug">磁盘分区</h2>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onRefresh}
          title="刷新分区信息"
          aria-label="刷新分区信息"
        >
          <RefreshCw />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto border-t border-line">
        {volumes.length === 0 && (
          <div className="px-3 py-3 text-[11px] leading-relaxed text-dim">正在读取磁盘…</div>
        )}
        {volumes.map((volume) => {
          const ratio = volume.total > 0 ? volume.used / volume.total : 0
          const percent = Math.round(ratio * 100)
          return (
            <div
              key={volume.name}
              data-testid="volume-row"
              className="border-b border-line px-3 py-2.5 transition-colors duration-150 hover:bg-panel-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="num text-[12.5px] font-bold">{volume.name}</span>
                <span className="num text-[11px] text-dim">已用 {percent}%</span>
              </div>
              <SegBar
                ratio={ratio}
                tone={freeTone(volume.free)}
                segments={26}
                size="xs"
                className="mt-1.5"
                aria-label={`${volume.name} 已用 ${percent}%，剩余 ${formatBytes(volume.free)}`}
              />
              <div className="num mt-1.5 flex items-baseline justify-between gap-2 text-[10.5px] text-faint">
                <span className="truncate">剩余 {formatBytes(volume.free)}</span>
                <span className="shrink-0">共 {formatBytes(volume.total)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
