import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import type { ServiceCandidate, ServiceRunState, ServiceWatchItem } from '@shared/services'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  /** 已在关注清单里的服务名（列表里标出来，避免重复关注） */
  watched: readonly string[]
  onOpenChange: (open: boolean) => void
  onAdded: (items: ServiceWatchItem[]) => void
}

const STATE_TEXT: Record<ServiceRunState, string> = {
  running: '在跑',
  stopped: '停着',
  pending: '切换中',
  unknown: '未知'
}

const INPUT_CLASS =
  'h-7 w-full rounded-sm border border-line-2 bg-panel-2 pl-7 pr-2 text-[12px] outline-none transition-colors duration-150 placeholder:text-faint focus-visible:border-fg/40'

const MAX_SHOWN = 60

/** 关注服务：搜索本机服务后点选（全量 300 左右，用搜索而不是滚动去找） */
export function AddServiceDialog({ open, watched, onOpenChange, onAdded }: Props): JSX.Element {
  const [candidates, setCandidates] = useState<ServiceCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setError(null)
    setLoading(true)
    let alive = true
    window.opsCabin
      .listServiceCandidates()
      .then((next) => {
        if (alive) setCandidates(next)
      })
      .catch(() => {
        if (alive) setError('读不到服务列表 —— 可能是权限不足')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open])

  const watchedLower = useMemo(
    () => new Set(watched.map((name) => name.toLowerCase())),
    [watched]
  )

  const shown = useMemo(() => {
    const text = query.trim().toLowerCase()
    const matched =
      text.length === 0
        ? candidates
        : candidates.filter(
            (item) =>
              item.name.toLowerCase().includes(text) ||
              item.displayName.toLowerCase().includes(text)
          )
    // 在跑的排前面：要关注的服务绝大多数是「应该一直在跑」的那种
    return [...matched]
      .sort((a, b) => {
        const rank = (state: ServiceRunState): number => (state === 'running' ? 0 : 1)
        if (rank(a.state) !== rank(b.state)) return rank(a.state) - rank(b.state)
        return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
      })
      .slice(0, MAX_SHOWN)
  }, [candidates, query])

  const total = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (text.length === 0) return candidates.length
    return candidates.filter(
      (item) =>
        item.name.toLowerCase().includes(text) || item.displayName.toLowerCase().includes(text)
    ).length
  }, [candidates, query])

  const pick = async (item: ServiceCandidate): Promise<void> => {
    if (watchedLower.has(item.name.toLowerCase()) || saving) return
    setSaving(true)
    try {
      const items = await window.opsCabin.addServiceWatch(item.name, item.displayName)
      onAdded(items)
      toast.success(`已关注服务 ${item.displayName}`)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent data-testid="add-service-dialog" className="max-w-lg">
        <DialogHeader className="gap-1.5">
          <div className="eyebrow text-faint">SERVICE · WATCH</div>
          <DialogTitle className="text-[14px] font-bold">关注服务</DialogTitle>
          <DialogDescription className="text-[12px] text-dim">
            关注后端口页会显示这些服务有没有在跑。停着的、以及本机已经没有的服务会亮灯 ——
            「该跑的没跑」比「谁在监听」更值得早一点知道。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="relative">
            <Search
              size={12}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索服务名或显示名，例如 docker / MySQL"
              aria-label="搜索服务"
              data-testid="service-search"
              className={INPUT_CLASS}
            />
          </div>

          <div className="max-h-[300px] overflow-auto rounded-sm border border-line">
            {loading ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-dim">
                正在读取本机服务列表……
              </div>
            ) : error ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-danger">{error}</div>
            ) : shown.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-dim">
                没有匹配「{query.trim()}」的服务。
              </div>
            ) : (
              shown.map((item) => {
                const already = watchedLower.has(item.name.toLowerCase())
                return (
                  <button
                    key={item.name}
                    type="button"
                    data-testid="service-option"
                    data-name={item.name}
                    data-already={already ? 'true' : 'false'}
                    disabled={already || saving}
                    onClick={() => void pick(item)}
                    className={
                      already
                        ? 'flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0'
                        : 'flex w-full cursor-pointer items-center gap-3 border-b border-line px-3 py-2 text-left transition-colors duration-150 last:border-b-0 hover:bg-panel-2'
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          already ? 'block truncate text-[12.5px] text-faint' : 'block truncate text-[12.5px]'
                        }
                      >
                        {item.displayName}
                      </span>
                      <span className="num block truncate text-[10.5px] text-faint">
                        {item.name} · {item.startMode}
                      </span>
                    </span>
                    <span
                      className={
                        already
                          ? 'shrink-0 text-[11px] text-faint'
                          : item.state === 'running'
                            ? 'shrink-0 text-[11px] text-dim'
                            : 'shrink-0 text-[11px] text-faint'
                      }
                    >
                      {already ? '已关注' : STATE_TEXT[item.state]}
                    </span>
                  </button>
                )
              })
            )}
            {!loading && !error && total > shown.length && (
              <div className="num border-t border-line bg-panel-2 px-3 py-1.5 text-[10.5px] text-faint">
                匹配 {total} 个，只列出前 {shown.length} 个 —— 再补几个字缩小范围
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={saving}>
              关闭
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
