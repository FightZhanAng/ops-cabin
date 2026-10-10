import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { ArrowDown, ArrowUp, Search, Star } from 'lucide-react'
import type { PortEntry } from '@shared/ports'
import { formatBytes, formatDuration } from '@shared/format'
import { Rocker, type RockerOption } from '@/components/instrument/rocker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
type ProtocolFilter = 'all' | 'tcp' | 'udp'

const PROTOCOL_OPTIONS: ReadonlyArray<RockerOption<ProtocolFilter>> = [
  { value: 'all', label: '全部', testId: 'proto-all' },
  { value: 'tcp', label: 'TCP', testId: 'proto-tcp' },
  { value: 'udp', label: 'UDP', testId: 'proto-udp' }
]

/** 全部监听端口表：搜索 + 协议拨档 + 排序 + 关注切换 */
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

  const sortableHead = (
    label: string,
    key: SortKey,
    className: string,
    align: 'left' | 'right' = 'left'
  ): JSX.Element => (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => headerSort(key)}
        className={cn(
          'flex w-full cursor-pointer items-center gap-1 text-[11px] font-medium transition-colors duration-150 hover:text-fg',
          align === 'right' && 'justify-end'
        )}
      >
        {label}
        {sortKey === key &&
          (sortDesc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </TableHead>
  )

  return (
    <div data-testid="port-table">
      {/* 读数与筛选行 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索端口 / 进程 / 路径"
            data-testid="port-search"
            className="h-7 w-56 rounded-sm border border-line-2 bg-panel-2 pl-7 pr-2 text-[12px] outline-none transition-colors duration-150 placeholder:text-faint focus-visible:border-fg/40"
          />
        </div>
        <Rocker
          size="sm"
          aria-label="协议筛选"
          value={protocol}
          onChange={setProtocol}
          options={PROTOCOL_OPTIONS}
        />
        <span className="num ml-auto text-[11px] text-dim">
          {filtered.length} / {entries.length} 条
        </span>
      </div>

      {/* table-fixed + 全列定宽：窄窗口下不横向溢出，长内容在单元格内截断 */}
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {sortableHead('端口', 'port', 'w-[56px]')}
            <TableHead className="w-[54px]">协议</TableHead>
            <TableHead className="w-[22%]">监听地址</TableHead>
            <TableHead className="w-[22%]">进程</TableHead>
            <TableHead className="w-[62px] text-right">PID</TableHead>
            {sortableHead('内存', 'memory', 'w-[80px]', 'right')}
            {sortableHead('运行时长', 'started', 'w-[76px]', 'right')}
            <TableHead className="w-9" />
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
              <TableCell className="num text-[13px] font-bold">{entry.port}</TableCell>
              <TableCell>
                <Badge variant="outline" className="uppercase">
                  {entry.protocol}
                </Badge>
              </TableCell>
              <TableCell
                className="num truncate text-[11px] text-dim"
                title={entry.addresses.join('  ')}
              >
                {entry.addresses.join('  ')}
              </TableCell>
              <TableCell className="truncate text-[12.5px]" title={entry.processName ?? ''}>
                {entry.processName ?? '—'}
              </TableCell>
              <TableCell className="num text-right text-[12px] text-dim">{entry.pid}</TableCell>
              <TableCell className="num text-right text-[12.5px]">
                {entry.memoryBytes !== null ? formatBytes(entry.memoryBytes) : '—'}
              </TableCell>
              <TableCell className="num text-right text-[12.5px] text-dim">
                {entry.startedAt ? formatDuration(Date.now() - entry.startedAt) : '—'}
              </TableCell>
              <TableCell className="text-center" onClick={(event) => event.stopPropagation()}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="port-watch-toggle"
                  title={entry.watched ? '取消关注' : '关注这个端口'}
                  aria-label={entry.watched ? `取消关注端口 ${entry.port}` : `关注端口 ${entry.port}`}
                  aria-pressed={entry.watched}
                  onClick={() => onToggleWatch(entry)}
                >
                  <Star className={cn(entry.watched ? 'fill-current text-fg' : 'text-dim')} />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
