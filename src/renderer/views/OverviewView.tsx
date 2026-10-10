import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { VolumeInfo } from '@shared/disk'
import type { PortChange, PortsSnapshot, WatchItem } from '@shared/ports'
import { Bay, Plate } from '@/components/instrument/plate'
import { AlertFeed } from '@/components/overview/AlertFeed'
import { MetricsPanel } from '@/components/overview/MetricsPanel'
import { PartitionBars } from '@/components/overview/PartitionBars'
import { WatchGrid } from '@/components/ports/WatchGrid'

interface Props {
  onNavigate: (view: 'disk' | 'ports') => void
}

/** 总览：一屏回答「现在什么状况」—— 信号条报警、每个 bay 都是入口 */
export function OverviewView({ onNavigate }: Props): JSX.Element {
  const [volumes, setVolumes] = useState<VolumeInfo[]>([])
  const [snapshot, setSnapshot] = useState<PortsSnapshot | null>(null)
  const [watchlist, setWatchlist] = useState<WatchItem[]>([])
  const [changes, setChanges] = useState<PortChange[]>([])

  const loadVolumes = useCallback((): void => {
    window.opsCabin
      .listVolumes()
      .then(setVolumes)
      .catch(() => setVolumes([]))
  }, [])
  useEffect(() => {
    loadVolumes()
  }, [loadVolumes])

  // 端口数据（总览同样实时刷新；离开页面即退订）
  useEffect(() => {
    let alive = true
    void window.opsCabin.getWatchlist().then((items) => {
      if (alive) setWatchlist(items)
    })
    void window.opsCabin.listPortEvents().then((events) => {
      if (alive) setChanges(events)
    })
    void window.opsCabin.listPorts().then((snap) => {
      if (alive && snap) setSnapshot(snap)
    })
    void window.opsCabin.subscribePorts()
    const offSnapshot = window.opsCabin.onPortsSnapshot((snap) => setSnapshot(snap))
    const offChanges = window.opsCabin.onPortsChanges((incoming) => {
      setChanges((prev) => [...incoming].reverse().concat(prev).slice(0, 50))
    })
    return () => {
      alive = false
      offSnapshot()
      offChanges()
      void window.opsCabin.unsubscribePorts()
    }
  }, [])

  const entries = snapshot?.entries ?? []

  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="overview-view">
      <div className="flex flex-col gap-3">
        <AlertFeed
          volumes={volumes}
          changes={changes}
          onOpenDisk={() => onNavigate('disk')}
          onOpenPorts={() => onNavigate('ports')}
        />

        <Plate className="grid-cols-[minmax(0,3fr)_minmax(0,2fr)] max-[880px]:grid-cols-1">
          <Bay
            eyebrow="STORAGE"
            title="磁盘"
            aside={<span className="text-[10.5px] text-dim">进入磁盘页</span>}
            tooltip="点击进入磁盘页"
            onClick={() => onNavigate('disk')}
            data-testid="partition-bars"
          >
            <PartitionBars volumes={volumes} />
          </Bay>
          <MetricsPanel />
        </Plate>

        <Plate>
          <Bay
            eyebrow="RADAR · WATCH"
            title="关注端口"
            aside={
              <span className="num text-[10.5px] text-faint">
                {watchlist.length > 0 ? `${watchlist.length} 个 · 进入端口页` : '进入端口页'}
              </span>
            }
            tooltip="点击进入端口页"
            onClick={() => onNavigate('ports')}
            data-testid="overview-watch"
          >
            {watchlist.length === 0 ? (
              <div className="py-1 text-[11px] leading-relaxed text-dim">
                还没有关注任何端口 —— 去端口页给常用的开发端口加个关注。
              </div>
            ) : (
              <WatchGrid
                watchlist={watchlist}
                entries={entries}
                onOpen={() => onNavigate('ports')}
                onRemove={() => onNavigate('ports')}
                onAdd={() => onNavigate('ports')}
              />
            )}
          </Bay>
        </Plate>
      </div>
    </div>
  )
}
