import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PortChange, PortEntry, PortsSnapshot, WatchItem } from '@shared/ports'
import { formatClock } from '@shared/format'
import { Bay, Plate } from '@/components/instrument/plate'
import { Scope } from '@/components/instrument/scope'
import { AddWatchDialog } from '@/components/ports/AddWatchDialog'
import { ChangeTimeline } from '@/components/ports/ChangeTimeline'
import { PortTable } from '@/components/ports/PortTable'
import { ProcDialog } from '@/components/ports/ProcDialog'
import { WatchGrid } from '@/components/ports/WatchGrid'

/** 端口页：关注端口读数台 + 雷达底座 + 全部监听端口表 + 变化记录右轨 */
export function PortsView(): JSX.Element {
  const [snapshot, setSnapshot] = useState<PortsSnapshot | null>(null)
  const [watchlist, setWatchlist] = useState<WatchItem[]>([])
  const [changes, setChanges] = useState<PortChange[]>([])
  const [focus, setFocus] = useState<PortEntry | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addSeed, setAddSeed] = useState<number | null>(null)

  // 进入页面：拉初始数据并订阅；离开页面：退订（主进程随之降频/停止轮询）
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
      setChanges((prev) => [...incoming].reverse().concat(prev).slice(0, 200))
    })
    return () => {
      alive = false
      offSnapshot()
      offChanges()
      void window.opsCabin.unsubscribePorts()
    }
  }, [])

  const entries = snapshot?.entries ?? []

  const toggleWatch = useCallback(async (entry: PortEntry): Promise<void> => {
    const items = entry.watched
      ? await window.opsCabin.removeWatch(entry.port)
      : await window.opsCabin.addWatch({
          port: entry.port,
          label: entry.processName ? `${entry.processName} :${entry.port}` : `端口 ${entry.port}`
        })
    setWatchlist(items)
  }, [])

  const removeWatch = useCallback(async (port: number): Promise<void> => {
    const items = await window.opsCabin.removeWatch(port)
    setWatchlist(items)
  }, [])

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-auto p-4">
        <div className="flex flex-col gap-3">
          {/* 关注端口读数台 + 雷达底座 */}
          <Plate className="grid-cols-[minmax(0,1fr)_212px]">
            <Bay
              eyebrow="RADAR · WATCH"
              title="关注端口"
              hint={
                <span data-testid="ports-status">
                  每 2 秒刷新 · 更新于 <span className="num text-fg">
                    {snapshot ? formatClock(snapshot.at) : '—'}
                  </span>
                  {snapshot?.degraded ? ' · 部分进程信息缺失' : ''}
                </span>
              }
            >
              <WatchGrid
                watchlist={watchlist}
                entries={entries}
                onOpen={setFocus}
                onRemove={(port) => void removeWatch(port)}
                onAdd={() => {
                  setAddSeed(null)
                  setAddOpen(true)
                }}
              />
            </Bay>

            <Bay eyebrow="SCOPE" pad="none" bodyClassName="bg-panel-2 p-2">
              <div className="flex justify-center rounded-sm border border-line px-1 py-2">
                <Scope watchlist={watchlist} entries={entries} />
              </div>
            </Bay>
          </Plate>

          {/* 全部监听端口 */}
          <Plate>
            <Bay eyebrow="LISTENERS" title="全部监听端口" pad="none">
              <PortTable
                entries={entries}
                onOpen={setFocus}
                onToggleWatch={(entry) => void toggleWatch(entry)}
              />
            </Bay>
          </Plate>
        </div>
      </div>

      <ChangeTimeline changes={changes} />

      <ProcDialog
        entry={focus}
        onOpenChange={(open) => {
          if (!open) setFocus(null)
        }}
        onToggleWatch={(entry) => void toggleWatch(entry)}
      />

      <AddWatchDialog
        open={addOpen}
        initialPort={addSeed}
        onOpenChange={setAddOpen}
        onAdded={(items) => setWatchlist(items)}
      />
    </div>
  )
}
