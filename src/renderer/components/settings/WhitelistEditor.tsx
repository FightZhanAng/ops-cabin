import type { JSX } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  whitelist: string[]
  onAdd: () => void
  onRemove: (path: string) => void
}

/** 白名单编辑器：加目录走系统选择器，逐项可移除 */
export function WhitelistEditor({ whitelist, onAdd, onRemove }: Props): JSX.Element {
  return (
    <div className="space-y-2" data-testid="whitelist-editor">
      {whitelist.length === 0 && (
        <div className="text-[11px] leading-relaxed text-dim">
          还没有保护目录 —— 白名单里的目录在扫描与清理时都会被跳过。
        </div>
      )}

      {whitelist.map((path) => (
        <div
          key={path}
          data-testid="whitelist-item"
          className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-3 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
            {path}
          </span>
          <button
            type="button"
            data-testid="whitelist-remove"
            title="移除"
            className="cursor-pointer rounded p-0.5 text-dim transition-colors duration-150 hover:text-danger"
            onClick={() => onRemove(path)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}

      <Button size="sm" variant="outline" data-testid="whitelist-add" onClick={onAdd}>
        添加目录…
      </Button>
    </div>
  )
}
