import type { JSX } from 'react'
import type { VolumeInfo } from '@shared/disk'
import { formatBytes } from '@shared/format'
import { SegBar, freeTone } from '@/components/instrument/seg-bar'

interface Props {
  volumes: VolumeInfo[]
}

/** 分区读数：盘符 + 分段仪表条 + 剩余/总量；所在 bay 负责点击跳转 */
export function PartitionBars({ volumes }: Props): JSX.Element {
  if (volumes.length === 0) {
    return <div className="py-1 text-[11px] text-dim">正在读取磁盘…</div>
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-5 gap-y-3">
      {volumes.map((volume) => {
        const ratio = volume.total > 0 ? volume.used / volume.total : 0
        const percent = Math.round(ratio * 100)
        return (
          <div key={volume.name} data-testid="overview-volume" className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="num text-[13px] font-bold">{volume.name}</span>
              <span className="num text-[12px]">剩余 {formatBytes(volume.free)}</span>
            </div>
            <SegBar
              ratio={ratio}
              tone={freeTone(volume.free)}
              segments={26}
              size="sm"
              className="mt-1.5"
              aria-label={`${volume.name} 已用 ${percent}%`}
            />
            <div className="num mt-1 flex items-baseline justify-between text-[10.5px] text-faint">
              <span>已用 {percent}%</span>
              <span>共 {formatBytes(volume.total)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
