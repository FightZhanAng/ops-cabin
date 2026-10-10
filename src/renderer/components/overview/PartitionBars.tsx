import type { JSX } from 'react'
import type { VolumeInfo } from '@shared/disk'
import { formatBytes } from '@shared/format'

interface Props {
  volumes: VolumeInfo[]
  onOpenDisk: () => void
}

/** 顶部分区条：每盘一条占用横条 + 剩余数字；整块可点进磁盘页 */
export function PartitionBars({ volumes, onOpenDisk }: Props): JSX.Element {
  return (
    <section
      className="cursor-pointer rounded-[10px] border border-line bg-panel p-4 transition-colors duration-150 hover:border-signal/40"
      onClick={onOpenDisk}
      title="查看磁盘页"
      data-testid="partition-bars"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">磁盘</h2>
        <span className="text-[10px] text-dim">点击进入磁盘页</span>
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {volumes.length === 0 && <div className="text-[11px] text-dim">读取中…</div>}
        {volumes.map((volume) => {
          const percent = volume.total > 0 ? Math.round((volume.used / volume.total) * 100) : 0
          const low = volume.free < 10 * 1024 ** 3
          return (
            <div key={volume.name} data-testid="overview-volume">
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="font-mono font-medium">{volume.name}</span>
                <span className="font-mono text-dim tabular-nums">
                  剩余 {formatBytes(volume.free)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2">
                <div
                  className={`h-full rounded-full ${low ? 'bg-warn' : 'bg-signal'}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
