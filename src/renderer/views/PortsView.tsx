import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PortChange, PortEntry, PortsSnapshot, WatchItem } from '@shared/ports'
import { formatClock } from '@shared/format'
import { AddWatchDialog } from '@/components/ports/AddWatchDialog'
import { ChangeTimeline } from '@/components/ports/ChangeTimeline'
import { PortTable } from '@/components/ports/PortTable'
import { ProcDialog } from '@/components/ports/ProcDialog'
import { WatchGrid } from '@/components/ports/WatchGrid'
import { Separator } from '@/components/ui/separator'

/** 端口页：关注端口卡片阵 + 全部监听端口表 + 变化时间线 */
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
      <div className="min-w-0 flex-1 overflow-auto px-4 py-3">
        {/* 关注端口（雷达区） */}
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">关注端口</h2>
          <span className="text-[10px] text-dim" data-testid="ports-status">
            {snapshot
              ? `每 2 秒刷新 · 更新于 ${formatClock(snapshot.at)}`
              : '正在读取端口…'}
            {snapshot?.degraded ? ' · 部分进程信息缺失' : ''}
          </span>
        </div>

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

        <Separator className="my-4" />

        {/* 全部监听端口 */}
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">全部监听端口</h2>
        </div>
        <PortTable
          entries={entries}
          onOpen={setFocus}
          onToggleWatch={(entry) => void toggleWatch(entry)}
        />
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
