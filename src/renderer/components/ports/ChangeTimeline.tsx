import type { JSX } from 'react'
import type { PortChange } from '@shared/ports'
import { formatClock } from '@shared/format'
import { Lamp } from '@/components/instrument/lamp'
import type { LampState } from '@/components/instrument/lamp'
import { cn } from '@/lib/utils'

interface Props {
  changes: PortChange[]
}

const TYPE_TEXT: Record<PortChange['type'], string> = {
  occupy: '被占用',
  release: '已释放',
  change: '换了占用者'
}

/** 类型词只在颜色上区分：占用是中性事实（墨阶），换主才是注意（黄） */
const TYPE_CLASS: Record<PortChange['type'], string> = {
  occupy: 'text-fg',
  release: 'text-dim',
  change: 'text-warn'
}

const TYPE_LAMP: Record<PortChange['type'], LampState> = {
  occupy: 'ink',
  release: 'idle',
  change: 'warn'
}

/** 关注端口的变化记录（新的在上）：右轨独立滚动 */
export function ChangeTimeline({ changes }: Props): JSX.Element {
  return (
    <aside
      className="flex w-[264px] shrink-0 flex-col border-l border-line bg-panel"
      data-testid="change-timeline"
    >
      <header className="border-b border-line px-3.5 py-3">
        <div className="eyebrow text-faint">EVENTS</div>
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">变化记录</h2>
          <span className="num ml-auto text-[10.5px] text-faint">{changes.length}</span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {changes.length === 0 ? (
          <div className="px-3.5 py-3 text-[11px] leading-relaxed text-dim">
            还没有变化记录 —— 关注的端口有变化时会记在这里。
          </div>
        ) : (
          <div className="divide-y divide-line">
            {changes.map((change, index) => (
              <div
                key={`${change.at}-${change.port}-${index}`}
                data-testid="change-entry"
                className="px-3.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <Lamp state={TYPE_LAMP[change.type]} size={6} />
                  <span className="num text-[10.5px] text-faint">{formatClock(change.at)}</span>
                  <span className="num text-[12.5px] font-bold">{change.port}</span>
                  <span className={cn('text-[11px]', TYPE_CLASS[change.type])}>
                    {TYPE_TEXT[change.type]}
                  </span>
                </div>
                {change.process && (
                  <div className="num mt-0.5 truncate text-[10.5px] text-dim" title={change.process}>
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
