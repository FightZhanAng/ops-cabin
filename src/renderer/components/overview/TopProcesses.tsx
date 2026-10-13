import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatBytes, formatCount } from '@shared/format'
import type { ProcEntry } from '@shared/processes'
import { Rocker } from '@/components/instrument/rocker'
import { SegBar } from '@/components/instrument/seg-bar'
import { Button } from '@/components/ui/button'

/*
 * 进程榜：谁在吃内存 / 谁在吃 CPU。
 *
 * 内存列与 CPU 列的量纲没法同框比较，所以用拨档切换而不是并排两列 ——
 * 并排时每行两条不同量纲的条很容易被误读成「两个都高」。
 * 条一律用中性墨阶（`ink`）：这是相对量级，不是负载告警，不能借用信号色。
 */

/** 主进程给的并集：内存前 N ∪ CPU 前 N；这里按当前档位排序后只显示前 N 行 */
const TOP_N = 12
/** 刷新节奏：进程榜看的是趋势，20 秒足够，也更省（每次刷新要起一个 PowerShell） */
const REFRESH_MS = 20_000

type SortKey = 'mem' | 'cpu'

const OPTIONS = [
  { value: 'mem' as const, label: '按内存', testId: 'process-sort-mem' },
  { value: 'cpu' as const, label: '按 CPU', testId: 'process-sort-cpu' }
]

function valueOf(entry: ProcEntry, key: SortKey): number {
  if (key === 'cpu') return entry.cpuPercent ?? -1
  return entry.memoryBytes
}

function readout(entry: ProcEntry, key: SortKey): string {
  if (key === 'cpu') return entry.cpuPercent === null ? '—' : `${entry.cpuPercent}%`
  return formatBytes(entry.memoryBytes)
}

export function TopProcesses(): JSX.Element {
  const [entries, setEntries] = useState<ProcEntry[]>([])
  const [sort, setSort] = useState<SortKey>('mem')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback((): void => {
    setBusy(true)
    window.opsCabin
      .listTopProcesses(TOP_N)
      .then((next) => {
        setEntries(next)
        setLoaded(true)
      })
      .catch(() => setEntries([]))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  const sorted = [...entries].sort((a, b) => valueOf(b, sort) - valueOf(a, sort)).slice(0, TOP_N)
  const peak = Math.max(...sorted.map((entry) => valueOf(entry, sort)), 1)
  // CPU 要两次采样才有基线：第一次刷新整列都是 null，别让用户对着「—」猜
  const cpuWaiting = sort === 'cpu' && sorted.every((entry) => entry.cpuPercent === null)

  return (
    <div data-testid="process-top" data-sort={sort} data-rows={sorted.length}>
      <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-0.5">
        <span className="num text-[11px] text-dim">
          {loaded ? `共 ${formatCount(entries.length)} 个候选 · 每 20 秒刷新` : '采样中…'}
        </span>
        <Rocker
          options={OPTIONS}
          value={sort}
          onChange={setSort}
          size="sm"
          aria-label="进程排序"
          className="ml-auto"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={load}
          disabled={busy}
          title="立即刷新"
          aria-label="立即刷新"
        >
          <RefreshCw />
        </Button>
      </div>

      {cpuWaiting ? (
        <div className="px-3.5 pb-3 text-[11px] leading-relaxed text-dim">
          CPU 占用靠两次采样做差 —— 基线还在攒（约 1 秒），稍等即可。
        </div>
      ) : sorted.length === 0 ? (
        <div className="px-3.5 pb-3 text-[11px] leading-relaxed text-dim">
          读不到进程表 —— 大概率是 PowerShell 通道被拦了。
        </div>
      ) : (
        <div className="border-t border-line" data-testid="process-rows">
          {sorted.map((entry, index) => (
            <div
              key={entry.pid}
              data-testid="process-row"
              data-pid={entry.pid}
              data-value={valueOf(entry, sort)}
              className="flex items-center gap-2.5 border-b border-line px-3.5 py-1.5 last:border-b-0"
            >
              <span className="num w-[14px] shrink-0 text-right text-[10.5px] text-faint">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px]" title={`${entry.name} · PID ${entry.pid}`}>
                {entry.name}
                <span className="num ml-1.5 text-[10.5px] text-faint">{entry.pid}</span>
              </span>
              <SegBar
                ratio={valueOf(entry, sort) / peak}
                tone="ink"
                segments={16}
                size="xs"
                className="w-[84px] shrink-0"
                aria-label={`${entry.name} ${readout(entry, sort)}`}
              />
              <span className="num w-[64px] shrink-0 text-right text-[12px] font-medium">
                {readout(entry, sort)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
