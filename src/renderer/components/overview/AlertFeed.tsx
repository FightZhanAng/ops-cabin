import type { JSX } from 'react'
import type { VolumeInfo } from '@shared/disk'
import type { PortChange } from '@shared/ports'
import { formatBytes, formatClock } from '@shared/format'
import { Lamp } from '@/components/instrument/lamp'

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

/** 信号条（annunciator）：有情况才亮灯成条；一切正常时只有一盏绿灯和一句话 */
export function AlertFeed({ volumes, changes, onOpenDisk, onOpenPorts }: Props): JSX.Element {
  const lowVolumes = volumes.filter((volume) => volume.free < 10 * 1024 ** 3)
  const recentChanges = changes.slice(0, 5)
  const empty = lowVolumes.length === 0 && recentChanges.length === 0

  const itemClass =
    'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 bg-panel px-3.5 py-2.5 text-left text-[12px] transition-colors duration-150 hover:bg-panel-2'

  return (
    <div
      data-testid="alert-feed"
      className="flex items-stretch gap-px overflow-hidden rounded-lg border border-line-2 bg-line"
    >
      {empty ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 bg-panel px-3.5 py-2.5 text-[12px]">
          <Lamp state="ok" size={7} />
          <span className="font-medium">一切正常</span>
          <span className="truncate text-dim">—— 磁盘余量充足，关注端口没有新变化。</span>
        </div>
      ) : (
        <>
          {lowVolumes.map((volume) => (
            <button
              key={`vol-${volume.name}`}
              type="button"
              data-testid="alert-item"
              onClick={onOpenDisk}
              className={itemClass}
            >
              <Lamp state="warn" size={7} pulse />
              <span className="shrink-0 font-medium text-warn">磁盘将满</span>
              <span className="num truncate text-[11px] text-dim">
                {volume.name} 剩余 {formatBytes(volume.free)}
              </span>
            </button>
          ))}
          {recentChanges.map((change, index) => (
            <button
              key={`${change.at}-${change.port}-${index}`}
              type="button"
              data-testid="alert-item"
              onClick={onOpenPorts}
              className={itemClass}
            >
              {/* 端口被占用是中性事实：用墨阶表达，不用红 */}
              <Lamp state={change.type === 'release' ? 'idle' : 'ink'} size={7} />
              <span className="num shrink-0 text-[10.5px] text-faint">{formatClock(change.at)}</span>
              <span className="num shrink-0 font-medium">{change.port}</span>
              <span className="truncate text-dim">
                {TYPE_TEXT[change.type]}
                {change.type !== 'release' && change.process ? ` · ${change.process}` : ''}
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
