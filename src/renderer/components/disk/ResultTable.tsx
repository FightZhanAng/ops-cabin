import type { JSX } from 'react'
import type { ScanItem } from '@shared/disk'
import { formatBytes, formatCount } from '@shared/format'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
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
  items: ScanItem[]
  selected: Set<string>
  focusId: string | null
  emptyHint: string
  onToggle: (id: string) => void
  onToggleAll: (checked: boolean) => void
  onFocus: (item: ScanItem) => void
}

/** 扫描结果表：多选 + 点击查看详情；数字列等宽右对齐，不横向溢出 */
export function ResultTable({
  items,
  selected,
  focusId,
  emptyHint,
  onToggle,
  onToggleAll,
  onFocus
}: Props): JSX.Element {
  if (items.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-center text-[12px] leading-relaxed text-dim"
        data-testid="empty-state"
      >
        {emptyHint}
      </div>
    )
  }

  const allChecked = items.every((item) => selected.has(item.id))

  return (
    <div className="h-full overflow-auto" data-testid="result-table">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-panel">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <Checkbox
                checked={allChecked}
                aria-label="全选当前列表"
                onCheckedChange={(value) => onToggleAll(value === true)}
              />
            </TableHead>
            <TableHead>名称</TableHead>
            <TableHead>路径</TableHead>
            <TableHead className="w-24 text-right">大小</TableHead>
            <TableHead className="w-20 text-right">文件数</TableHead>
            <TableHead className="w-16 text-center">风险</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const isSelected = selected.has(item.id)
            const isFocus = focusId === item.id
            return (
              <TableRow
                key={item.id}
                data-testid="result-row"
                onClick={() => onFocus(item)}
                className={cn(
                  'cursor-pointer',
                  isFocus && 'bg-panel-2',
                  isSelected && 'bg-signal/10 hover:bg-signal/15'
                )}
              >
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    aria-label={`选择 ${item.label}`}
                    onCheckedChange={() => onToggle(item.id)}
                  />
                </TableCell>
                <TableCell className="max-w-[200px] truncate font-medium">{item.label}</TableCell>
                <TableCell
                  className="max-w-[320px] truncate font-mono text-[11px] text-dim"
                  title={item.path}
                >
                  {item.path}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] tabular-nums">
                  {formatBytes(item.bytes)}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] tabular-nums">
                  {formatCount(item.files)}
                </TableCell>
                <TableCell className="text-center">
                  {item.risk === 'careful' ? (
                    <Badge variant="outline" className="border-warn/40 text-[10px] text-warn">
                      谨慎
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-line text-[10px] text-dim">
                      安全
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
