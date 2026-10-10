import type { JSX } from 'react'
import type { PortChange } from '@shared/ports'
import { formatClock } from '@shared/format'

interface Props {
  changes: PortChange[]
}

const TYPE_TEXT: Record<PortChange['type'], string> = {
  occupy: '被占用',
  release: '已释放',
  change: '换了占用者'
}

/** 关注端口的变化时间线（新的在上） */
export function ChangeTimeline({ changes }: Props): JSX.Element {
  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-l border-line bg-panel"
      data-testid="change-timeline"
    >
      <div className="border-b border-line px-4 py-3">
        <span className="text-[13px] font-semibold">变化记录</span>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3">
        {changes.length === 0 ? (
          <div className="text-[11px] leading-relaxed text-dim">
            还没有变化记录 —— 关注的端口有变化时会记在这里。
          </div>
        ) : (
          <div className="space-y-3">
            {changes.map((change, index) => (
              <div
                key={`${change.at}-${change.port}-${index}`}
                data-testid="change-entry"
                className="text-[11px] leading-relaxed"
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[10px] text-dim">{formatClock(change.at)}</span>
                  <span className="font-mono font-medium tabular-nums">{change.port}</span>
                  <span className="text-dim">{TYPE_TEXT[change.type]}</span>
                </div>
                {change.process && (
                  <div
                    className="mt-0.5 truncate font-mono text-[10px] text-dim"
                    title={change.process}
                  >
                    {change.process}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
