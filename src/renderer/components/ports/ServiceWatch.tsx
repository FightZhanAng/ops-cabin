import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Plus, X } from 'lucide-react'
import type { ServiceStatus, ServiceStatusReport, ServiceWatchItem } from '@shared/services'
import { Button } from '@/components/ui/button'
import { Lamp, type LampState } from '@/components/instrument/lamp'
import { AddServiceDialog } from '@/components/ports/AddServiceDialog'

/*
 * 服务关注清单。
 *
 * 和「关注端口」是一对：端口回答**谁在听**，服务回答**该不该在跑**。
 * 两者放同一页是因为绝大多数服务后面就挂着一个端口 —— 端口没了往往因为
 * 服务停了，先看哪一边都行。
 *
 * 状态分六档而不是简单的「跑/没跑」，因为有两档特别容易做错：
 *   - 已禁用（Disabled）：停着是**正常**状态，不该亮灯；
 *   - 不在了（missing）：服务被卸载了，关注项成了空壳，要提醒的是「该清关注了」。
 * 把这两档并进「停了」，用户会天天看见假警报。
 */

type RowState = 'running' | 'down' | 'disabled' | 'missing' | 'pending' | 'unknown'

const STATE_TEXT: Record<RowState, string> = {
  running: '在跑',
  down: '停了',
  disabled: '已禁用',
  missing: '不在了',
  pending: '切换中',
  unknown: '未知'
}

const STATE_LAMP: Record<RowState, LampState | null> = {
  running: null,
  down: 'warn',
  disabled: 'idle',
  missing: 'warn',
  // 切换中是过渡态。亮警示灯会把「正在重启」当成故障，而且它一会儿就自己变回在跑 ——
  // 灯、本面板的数字、侧栏徽标必须是同一套判据，否则三处会各说各话
  pending: 'idle',
  unknown: null
}

const STATE_CLASS: Record<RowState, string> = {
  running: 'text-faint',
  down: 'text-warn',
  disabled: 'text-dim',
  missing: 'text-warn',
  pending: 'text-dim',
  unknown: 'text-faint'
}

function rowState(item: ServiceStatus): RowState {
  if (item.missing) return 'missing'
  if (item.state === 'running') return 'running'
  if (item.state === 'pending') return 'pending'
  // 禁用是「你自己关掉的」，不是故障 —— 这一档最容易被误报成「停了」
  if (item.state === 'stopped') return item.startMode === 'Disabled' ? 'disabled' : 'down'
  return 'unknown'
}

interface Props {
  /** 关注清单变化时通知宿主页面（端口页用来保持一致） */
  onWatchlistChange?: (items: ServiceWatchItem[]) => void
}

export function ServiceWatch({ onWatchlistChange }: Props): JSX.Element {
  const [watchlist, setWatchlist] = useState<ServiceWatchItem[]>([])
  const [report, setReport] = useState<ServiceStatusReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)

  const pullStatus = useCallback(async (): Promise<void> => {
    const next = await window.opsCabin.listServices()
    setReport(next)
  }, [])

  useEffect(() => {
    let alive = true
    void window.opsCabin.getServiceWatch().then((items) => {
      if (!alive) return
      setWatchlist(items)
      if (items.length === 0) {
        setLoading(false)
        return
      }
      void pullStatus().finally(() => {
        if (alive) setLoading(false)
      })
    })
    return () => {
      alive = false
    }
  }, [pullStatus])

  // 状态 30 秒一拍：服务会自己停，这个页面开着的时候就该看到它停
  useEffect(() => {
    if (watchlist.length === 0) return
    const timer = setInterval(() => void pullStatus(), 30_000)
    return () => clearInterval(timer)
  }, [watchlist.length, pullStatus])

  const applyWatchlist = (items: ServiceWatchItem[]): void => {
    setWatchlist(items)
    onWatchlistChange?.(items)
    void pullStatus()
  }

  const remove = async (name: string): Promise<void> => {
    const items = await window.opsCabin.removeServiceWatch(name)
    applyWatchlist(items)
  }

  /**
   * 「不在跑」的条数：停了（且不是被禁用）＋ 本机已经没有。
   *
   * 与侧栏徽标用同一套判据 —— 侧栏说 1、点进来面板说 2，用户会开始怀疑所有读数。
   * 禁用不算、切换中不算（见 STATE_LAMP 的说明）。
   */
  const statuses = report?.items ?? []
  const degraded = report?.degraded === true
  const down = statuses.filter((item) => {
    const state = rowState(item)
    return state === 'down' || state === 'missing'
  }).length

  return (
    <div
      data-testid="service-watch"
      data-count={watchlist.length}
      data-down={down}
      data-degraded={degraded}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2.5 px-3.5 pb-2 pt-0.5">
        <span className="num min-w-0 flex-1 truncate text-[11px] text-dim">
          {watchlist.length === 0
            ? '还没有关注任何服务'
            : loading
              ? `正在读取 ${watchlist.length} 个关注服务的状态……`
              : // 读不到必须单独说一句：此时 items 是空的，不拦一下就会印出
                // 「N 个关注 · 全部在跑」—— 一次采集失败被显示成一切正常。
                degraded
                ? `${watchlist.length} 个关注 · 状态读不到`
                : down > 0
                  ? `${watchlist.length} 个关注 · ${down} 个不在跑`
                  : `${watchlist.length} 个关注 · 全部在跑`}
        </span>
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => setAddOpen(true)}
          data-testid="service-add"
        >
          <Plus />
          关注服务
        </Button>
      </div>

      {watchlist.length === 0 ? (
        <div className="px-3.5 pb-3 text-[11px] leading-relaxed text-dim">
          关注服务后这里会显示它有没有在跑。停了的、以及本机已经没有的服务会亮灯 ——
          禁用的不算异常，那是你自己关掉的。
        </div>
      ) : degraded ? (
        // 读不到时不留一块空白：空白看起来像「没有服务」或「都正常」，
        // 而实际情况是这一拍没读到 —— 说清楚，并保留关注清单不动。
        <div
          data-testid="service-degraded"
          className="border-t border-line px-3.5 py-3 text-[11px] leading-relaxed text-warn"
        >
          读不到服务状态{report?.error ? `（${report.error}）` : ''}。
          <br />
          这不代表它们正常 —— 面板会在下一拍自动重试。
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto border-t border-line">
          {statuses.map((item) => {
            const state = rowState(item)
            const lamp = STATE_LAMP[state]
            return (
              <div
                key={item.name}
                data-testid="service-row"
                data-state={state}
                data-name={item.name}
                className="flex items-center gap-2.5 border-b border-line px-3.5 py-1.5 last:border-b-0"
              >
                <span className="flex w-[10px] shrink-0 items-center justify-center">
                  {lamp ? <Lamp state={lamp} size={7} label={STATE_TEXT[state]} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]">{item.label}</span>
                  <span className="num block truncate text-[10.5px] text-faint">
                    {item.displayName}
                    {item.startMode !== '未知' ? ` · ${item.startMode}` : ''}
                  </span>
                </span>
                <span className={`shrink-0 text-[11px] ${STATE_CLASS[state]}`}>
                  {STATE_TEXT[state]}
                </span>
                <button
                  type="button"
                  aria-label={`不再关注 ${item.label}`}
                  title="不再关注"
                  onClick={() => void remove(item.name)}
                  data-testid="service-remove"
                  className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-faint transition-colors duration-150 hover:bg-panel-2 hover:text-fg"
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <AddServiceDialog
        open={addOpen}
        watched={watchlist.map((item) => item.name)}
        onOpenChange={setAddOpen}
        onAdded={applyWatchlist}
      />
    </div>
  )
}
