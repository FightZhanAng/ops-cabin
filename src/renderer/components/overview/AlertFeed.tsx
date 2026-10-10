import type { JSX } from 'react'
import type { VolumeInfo } from '@shared/disk'
import type { PortChange } from '@shared/ports'
import { formatBytes, formatClock } from '@shared/format'

interface Props {
  volumes: VolumeInfo[]
  changes: PortChange[]
  onOpenDisk: () => void
  onOpenPorts: () => void
}

const TYPE_TEXT: Record<PortChange['type'], string> = {
  occupy: '被占用',
  release: '已释放',
  change: '换了占用者'
}

/** 提醒流：磁盘将满 + 关注端口的最近变化；点条目跳对应页 */
export function AlertFeed({ volumes, changes, onOpenDisk, onOpenPorts }: Props): JSX.Element {
  const lowVolumes = volumes.filter((volume) => volume.free < 10 * 1024 ** 3)
  const recentChanges = changes.slice(0, 5)
  const empty = lowVolumes.length === 0 && recentChanges.length === 0

  return (
    <section className="rounded-[10px] border border-line bg-panel p-4" data-testid="alert-feed">
      <h2 className="text-[13px] font-semibold">提醒</h2>

      {empty ? (
        <div className="mt-2 text-[11px] leading-relaxed text-dim">
          一切正常 —— 磁盘余量充足，关注端口没有新变化。
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {lowVolumes.map((volume) => (
            <li
              key={`vol-${volume.name}`}
              data-testid="alert-item"
              className="flex cursor-pointer items-baseline gap-2 text-[12px] transition-colors duration-150 hover:text-fg"
              onClick={onOpenDisk}
            >
              <span className="text-warn">磁盘将满</span>
              <span className="font-mono text-dim tabular-nums">
                {volume.name} 剩余 {formatBytes(volume.free)}
              </span>
            </li>
          ))}
          {recentChanges.map((change, index) => (
            <li
              key={`${change.at}-${change.port}-${index}`}
              data-testid="alert-item"
              className="flex cursor-pointer items-baseline gap-2 text-[12px] transition-colors duration-150 hover:text-fg"
              onClick={onOpenPorts}
            >
              <span className="font-mono text-[10px] text-dim">{formatClock(change.at)}</span>
              <span className="font-mono tabular-nums">{change.port}</span>
              <span className="text-dim">{TYPE_TEXT[change.type]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
