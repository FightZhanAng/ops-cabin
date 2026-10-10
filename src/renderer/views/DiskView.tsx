import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import type {
  ScanGroupKey,
  ScanGroupResult,
  ScanItem,
  ScanProgress,
  VolumeInfo
} from '@shared/disk'
import { formatBytes } from '@shared/format'
import { CleanDialog } from '@/components/disk/CleanDialog'
import { DetailPanel } from '@/components/disk/DetailPanel'
import { PartitionList } from '@/components/disk/PartitionList'
import { ResultTable } from '@/components/disk/ResultTable'
import { ScanProgressBar } from '@/components/disk/ScanProgressBar'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const GROUP_ORDER: ScanGroupKey[] = ['safe', 'devCaches', 'largeFiles']

const GROUP_LABEL: Record<ScanGroupKey, string> = {
  safe: '安全清理',
  devCaches: '开发缓存',
  largeFiles: '大文件'
}

const EMPTY_HINT: Record<ScanGroupKey, string> = {
  safe: '还没有扫描结果 —— 点「开始扫描」检查系统临时文件与开发缓存。',
  devCaches: '还没有扫描结果 —— 点「开始扫描」检查系统临时文件与开发缓存。',
  largeFiles: '大文件扫描需要指定目录：点上方「扫描主目录」或「选择目录…」。'
}

/** 磁盘页：扫描 → 勾选 → 预览 → 清理 → 反馈 */
export function DiskView(): JSX.Element {
  const [groups, setGroups] = useState<ScanGroupResult[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState(0)
  const [tab, setTab] = useState<ScanGroupKey>('safe')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusItem, setFocusItem] = useState<ScanItem | null>(null)
  const [volumes, setVolumes] = useState<VolumeInfo[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => window.opsCabin.onScanProgress(setProgress), [])

  const loadVolumes = useCallback((): void => {
    window.opsCabin
      .listVolumes()
      .then(setVolumes)
      .catch(() => setVolumes([]))
  }, [])
  useEffect(() => {
    loadVolumes()
  }, [loadVolumes])

  const runScan = useCallback(
    async (keys: ScanGroupKey[], roots?: string[]): Promise<void> => {
      setScanning(true)
      setScanError(null)
      setProgress(null)
      try {
        const outcome = await window.opsCabin.startScan({ groups: keys, largeFileRoots: roots })
        if (!outcome.ok) {
          if (outcome.cancelled) toast('扫描已取消')
          else setScanError(outcome.error ?? '扫描失败')
          return
        }
        setSkipped(outcome.result.skipped)
        setSelected(new Set())
        setFocusItem(null)
        // 按组替换：本次扫了哪几组就换哪几组，其余保留
        setGroups((prev) => {
          const byKey = new Map(prev.map((group) => [group.group, group]))
          for (const key of keys) {
            const fresh = outcome.result.groups.find((group) => group.group === key)
            if (fresh) byKey.set(key, fresh)
            else byKey.delete(key)
          }
          return GROUP_ORDER.filter((key) => byKey.has(key)).map(
            (key) => byKey.get(key) as ScanGroupResult
          )
        })
        if (outcome.result.groups.length === 0) toast('没有发现可清理的项')
      } finally {
        setScanning(false)
        setProgress(null)
      }
    },
    []
  )

  const scanLargeIn = useCallback(
    async (roots?: string[]): Promise<void> => {
      setTab('largeFiles')
      await runScan(['largeFiles'], roots)
    },
    [runScan]
  )

  const pickAndScanLarge = useCallback(async (): Promise<void> => {
    const picked = await window.opsCabin.pickDirectory()
    if (picked) await scanLargeIn([picked])
  }, [scanLargeIn])

  const activeItems = useMemo(() => {
    const group = groups.find((g) => g.group === tab)
    return group ? [...group.items].sort((a, b) => b.bytes - a.bytes) : []
  }, [groups, tab])

  const selectedItems = useMemo(() => {
    const all = groups.flatMap((group) => group.items)
    return all.filter((item) => selected.has(item.id))
  }, [groups, selected])

  const selectedBytes = useMemo(
    () => selectedItems.reduce((sum, item) => sum + item.bytes, 0),
    [selectedItems]
  )

  const counts = useMemo(() => {
    const map = new Map<ScanGroupKey, number>()
    for (const group of groups) map.set(group.group, group.items.length)
    return map
  }, [groups])

  const toggleItem = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback(
    (checked: boolean): void => {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const item of activeItems) {
          if (checked) next.add(item.id)
          else next.delete(item.id)
        }
        return next
      })
    },
    [activeItems]
  )

  const handleCleaned = useCallback(
    (removedPaths: string[]): void => {
      const removed = new Set(removedPaths)
      setGroups((prev) =>
        prev
          .map((group) => {
            const items = group.items.filter((item) => !removed.has(item.path))
            return { ...group, items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) }
          })
          .filter((group) => group.items.length > 0)
      )
      setSelected((prev) => new Set([...prev].filter((id) => !removed.has(id))))
      setFocusItem((prev) => (prev && removed.has(prev.path) ? null : prev))
      loadVolumes()
    },
    [loadVolumes]
  )

  const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="flex h-full min-h-0">
      <PartitionList volumes={volumes} onRefresh={loadVolumes} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具条 */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Button
            size="sm"
            disabled={scanning}
            onClick={() => void runScan(['safe', 'devCaches'])}
            data-testid="scan-start"
          >
            {scanning ? '扫描中…' : '开始扫描'}
          </Button>
          {scanning && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void window.opsCabin.cancelScan()}
              data-testid="scan-cancel"
            >
              取消
            </Button>
          )}
          <div className="ml-auto flex items-center gap-3 text-[11px] text-dim">
            {scanError ? (
              <span className="text-danger">{scanError}</span>
            ) : (
              <>
                {skipped > 0 && <span>已跳过 {skipped} 个受限条目</span>}
                {totalItems > 0 && <span>共 {totalItems} 项候选</span>}
              </>
            )}
          </div>
        </div>

        {scanning && <ScanProgressBar progress={progress} />}

        {/* 分组切换 */}
        <Tabs value={tab} onValueChange={(value) => setTab(value as ScanGroupKey)}>
          <div className="flex items-center gap-2 border-b border-line px-4 pt-2">
            <TabsList>
              {GROUP_ORDER.map((key) => (
                <TabsTrigger key={key} value={key} data-testid={`tab-${key}`}>
                  {GROUP_LABEL[key]}
                  {counts.get(key) ? `（${counts.get(key)}）` : ''}
                </TabsTrigger>
              ))}
            </TabsList>
            {tab === 'largeFiles' && (
              <div className="ml-auto flex gap-2 pb-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={scanning}
                  onClick={() => void scanLargeIn()}
                  data-testid="scan-home"
                >
                  扫描主目录
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={scanning}
                  onClick={() => void pickAndScanLarge()}
                  data-testid="scan-pick"
                >
                  选择目录…
                </Button>
              </div>
            )}
          </div>
        </Tabs>

        {/* 结果表 */}
        <div className="min-h-0 flex-1">
          <ResultTable
            items={activeItems}
            selected={selected}
            focusId={focusItem?.id ?? null}
            emptyHint={EMPTY_HINT[tab]}
            onToggle={toggleItem}
            onToggleAll={toggleAll}
            onFocus={setFocusItem}
          />
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
          <span className="text-[12px] text-dim" data-testid="selection-summary">
            已选 {selectedItems.length} 项 · 预计释放 {formatBytes(selectedBytes)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                清除选择
              </Button>
            )}
            <Button
              size="sm"
              disabled={selectedItems.length === 0}
              onClick={() => setDialogOpen(true)}
              data-testid="clean-open"
            >
              清理选中项
            </Button>
          </div>
        </div>
      </div>

      {focusItem && <DetailPanel item={focusItem} onClose={() => setFocusItem(null)} />}

      <CleanDialog
        open={dialogOpen}
        items={selectedItems.map((item) => ({ path: item.path, bytes: item.bytes }))}
        onOpenChange={setDialogOpen}
        onDone={(result) => handleCleaned(result.removed)}
      />
    </div>
  )
}
