import type { JSX } from 'react'
import { FolderLock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  whitelist: string[]
  onAdd: () => void
  onRemove: (path: string) => void
}

/** 白名单编辑器：加目录走系统选择器，逐项可移除（路径是读数，等宽显示） */
export function WhitelistEditor({ whitelist, onAdd, onRemove }: Props): JSX.Element {
  return (
    <div data-testid="whitelist-editor">
      {whitelist.length === 0 ? (
        <p className="px-3.5 py-3 text-[11px] leading-relaxed text-dim">
          还没有保护目录 —— 白名单里的目录在扫描与清理时都会被跳过。
        </p>
      ) : (
        <div>
          {whitelist.map((path) => (
            <div
              key={path}
              data-testid="whitelist-item"
              className="flex min-h-[34px] items-center gap-2 border-b border-line px-3.5 last:border-b-0"
            >
              <FolderLock aria-hidden className="size-3.5 shrink-0 text-dim" />
              <span className="num min-w-0 flex-1 truncate text-[11.5px]" title={path}>
                {path}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="whitelist-remove"
                title="移出白名单"
                aria-label="移出白名单"
                className="hover:text-danger"
                onClick={() => onRemove(path)}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line px-3.5 py-2.5">
        <Button size="sm" variant="outline" data-testid="whitelist-add" onClick={onAdd}>
          添加目录…
        </Button>
      </div>
    </div>
  )
}
