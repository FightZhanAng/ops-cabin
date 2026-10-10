import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { VolumeInfo } from '@shared/disk'
import type { PortChange, PortsSnapshot, WatchItem } from '@shared/ports'
import { AlertFeed } from '@/components/overview/AlertFeed'
import { MetricsPanel } from '@/components/overview/MetricsPanel'
import { PartitionBars } from '@/components/overview/PartitionBars'
import { WatchGrid } from '@/components/ports/WatchGrid'

interface Props {
  onNavigate: (view: 'disk' | 'ports') => void
}

/** 总览：一屏回答「现在什么状况」—— 每个面板都是入口，不是信息终点 */
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
      <div className="space-y-4">
        <PartitionBars volumes={volumes} onOpenDisk={() => onNavigate('disk')} />

        <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
          <section
            className="cursor-pointer rounded-[10px] border border-line bg-panel p-4 transition-colors duration-150 hover:border-signal/40"
            onClick={() => onNavigate('ports')}
            title="查看端口页"
            data-testid="overview-watch"
          >
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold">关注端口</h2>
              <span className="text-[10px] text-dim">点击进入端口页</span>
            </div>
            {watchlist.length === 0 ? (
              <div className="text-[11px] leading-relaxed text-dim">
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
          </section>

          <MetricsPanel />
        </div>

        <AlertFeed
          volumes={volumes}
          changes={changes}
          onOpenDisk={() => onNavigate('disk')}
          onOpenPorts={() => onNavigate('ports')}
        />
      </div>
    </div>
  )
}
