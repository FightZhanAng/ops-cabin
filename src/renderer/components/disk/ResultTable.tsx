import type { JSX } from 'react'
import { AlertTriangle, FolderSearch, ShieldCheck } from 'lucide-react'
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

/** 扫描结果表：数字成列右对齐、路径等宽截断、风险双通道（颜色 + 文字），行可点开详情 */
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
        className="flex h-full flex-col items-center justify-center gap-2.5 p-8 text-center"
        data-testid="empty-state"
      >
        <FolderSearch className="size-5 text-faint" />
        <p className="max-w-[46ch] text-[12.5px] leading-relaxed text-dim">{emptyHint}</p>
      </div>
    )
  }

  const allChecked = items.every((item) => selected.has(item.id))

  return (
    // 表头 sticky 依赖这里的滚动容器：Table 内层的 overflow-x-auto 自成滚动口，会吃掉 sticky
    <div className="h-full overflow-auto [&>div]:overflow-visible" data-testid="result-table">
      <Table>
        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:border-b [&_th]:border-line">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <Checkbox
                checked={allChecked}
                aria-label="全选当前列表"
                onCheckedChange={(value) => onToggleAll(value === true)}
              />
            </TableHead>
            <TableHead className="text-[11px]">名称</TableHead>
            <TableHead className="text-[11px]">路径</TableHead>
            <TableHead className="w-24 text-right text-[11px]">大小</TableHead>
            <TableHead className="w-24 text-right text-[11px]">文件数</TableHead>
            <TableHead className="w-[76px] text-right text-[11px]">风险</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const isSelected = selected.has(item.id)
            const isFocus = focusId === item.id
            const careful = item.risk === 'careful'
            return (
              <TableRow
                key={item.id}
                data-testid="result-row"
                data-state={isSelected ? 'selected' : undefined}
                onClick={() => onFocus(item)}
                className={cn('cursor-pointer', isFocus && 'bg-panel-2')}
              >
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    aria-label={`选择 ${item.label}`}
                    onCheckedChange={() => onToggle(item.id)}
                  />
                </TableCell>
                <TableCell className="max-w-[220px] truncate font-medium">{item.label}</TableCell>
                <TableCell
                  className="num max-w-[320px] truncate text-[11.5px] text-dim"
                  title={item.path}
                >
                  {item.path}
                </TableCell>
                <TableCell className="num text-right">{formatBytes(item.bytes)}</TableCell>
                <TableCell className="num text-right">{formatCount(item.files)}</TableCell>
                <TableCell className="text-right">
                  {careful ? (
                    <Badge variant="warn">
                      <AlertTriangle />
                      谨慎
                    </Badge>
                  ) : (
                    <Badge variant="ok">
                      <ShieldCheck />
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
