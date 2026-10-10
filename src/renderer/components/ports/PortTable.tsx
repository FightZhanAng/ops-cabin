import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { ArrowDown, ArrowUp, Search, Star } from 'lucide-react'
import type { PortEntry } from '@shared/ports'
import { formatBytes, formatDuration } from '@shared/format'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

interface Props {
  entries: PortEntry[]
  onOpen: (entry: PortEntry) => void
  onToggleWatch: (entry: PortEntry) => void
}

type SortKey = 'port' | 'memory' | 'started'

const PROTOCOL_FILTERS = ['all', 'tcp', 'udp'] as const
type ProtocolFilter = (typeof PROTOCOL_FILTERS)[number]

const FILTER_LABEL: Record<ProtocolFilter, string> = { all: '全部', tcp: 'TCP', udp: 'UDP' }

/** 全部监听端口表：搜索 + 协议筛选 + 排序 + 关注切换 */
export function PortTable({ entries, onOpen, onToggleWatch }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [protocol, setProtocol] = useState<ProtocolFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('port')
  const [sortDesc, setSortDesc] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = entries.filter((entry) => {
      if (protocol !== 'all' && entry.protocol !== protocol) return false
      if (!q) return true
      const haystack = `${entry.port} ${entry.processName ?? ''} ${entry.processPath ?? ''} ${entry.addresses.join(' ')}`.toLowerCase()
      return haystack.includes(q)
    })
    const direction = sortDesc ? -1 : 1
    return [...list].sort((a, b) => {
      if (sortKey === 'port') return (a.port - b.port) * direction
      if (sortKey === 'memory') return ((a.memoryBytes ?? 0) - (b.memoryBytes ?? 0)) * direction
      return ((a.startedAt ?? 0) - (b.startedAt ?? 0)) * direction
    })
  }, [entries, query, protocol, sortKey, sortDesc])

  const headerSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDesc((prev) => !prev)
    } else {
      setSortKey(key)
      setSortDesc(false)
    }
  }

  const sortableHead = (label: string, key: SortKey, className: string): JSX.Element => (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => headerSort(key)}
        className="flex cursor-pointer items-center gap-1 text-[11px] font-medium"
      >
        {label}
        {sortKey === key &&
          (sortDesc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </TableHead>
  )

  return (
    <div data-testid="port-table">
      {/* 工具条 */}
      <div className="mb-2 flex items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索端口 / 进程 / 路径"
            data-testid="port-search"
            className="w-56 rounded-md border border-line bg-panel-2 py-1.5 pl-7 pr-2 text-[12px] outline-none transition-colors duration-150 placeholder:text-dim focus-visible:border-signal"
          />
        </div>
        <div className="flex items-center gap-0.5">
          {PROTOCOL_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`proto-${value}`}
              onClick={() => setProtocol(value)}
              className={cn(
                'cursor-pointer rounded-md px-2.5 py-1 text-[11px] transition-colors duration-150',
                protocol === value ? 'bg-panel-2 font-medium text-fg' : 'text-dim hover:text-fg'
              )}
            >
              {FILTER_LABEL[value]}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10px] text-dim">
          {filtered.length} / {entries.length} 条
        </span>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-line">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {sortableHead('端口', 'port', 'w-20')}
              <TableHead className="w-16 text-[11px]">协议</TableHead>
              <TableHead className="text-[11px]">监听地址</TableHead>
              <TableHead className="text-[11px]">进程</TableHead>
              <TableHead className="w-20 text-[11px]">PID</TableHead>
              {sortableHead('内存', 'memory', 'w-24 text-right')}
              {sortableHead('运行时长', 'started', 'w-24 text-right')}
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-[12px] text-dim">
                  {entries.length === 0 ? '正在读取端口…' : '没有匹配的端口'}
                </TableCell>
              </TableRow>
            )}
            {filtered.map((entry) => (
              <TableRow
                key={`${entry.protocol}:${entry.port}`}
                data-testid="port-row"
                data-port={entry.port}
                className="cursor-pointer"
                onClick={() => onOpen(entry)}
              >
                <TableCell className="font-mono text-[13px] font-medium tabular-nums">
                  {entry.port}
                </TableCell>
                <TableCell className="text-[10px] uppercase text-dim">{entry.protocol}</TableCell>
                <TableCell
                  className="max-w-[200px] truncate font-mono text-[11px] text-dim"
                  title={entry.addresses.join('  ')}
                >
                  {entry.addresses.join('  ')}
                </TableCell>
                <TableCell className="max-w-[160px] truncate text-[12px]">
                  {entry.processName ?? '—'}
                </TableCell>
                <TableCell className="font-mono text-[11px] tabular-nums text-dim">
                  {entry.pid}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] tabular-nums">
                  {entry.memoryBytes !== null ? formatBytes(entry.memoryBytes) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] tabular-nums text-dim">
                  {entry.startedAt ? formatDuration(Date.now() - entry.startedAt) : '—'}
                </TableCell>
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    data-testid="port-watch-toggle"
                    title={entry.watched ? '取消关注' : '关注这个端口'}
                    className="cursor-pointer rounded p-1 transition-colors duration-150 hover:bg-panel-2"
                    onClick={() => onToggleWatch(entry)}
                  >
                    <Star
                      className={cn(
                        'size-3.5',
                        entry.watched ? 'fill-signal text-signal' : 'text-dim'
                      )}
                    />
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
