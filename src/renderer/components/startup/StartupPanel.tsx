import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { formatClock } from '@shared/format'
import {
  STARTUP_SOURCE_LABEL,
  type StartupItem,
  type StartupReport,
  type StartupSource
} from '@shared/startup'
import { cn } from 'cn'
import { Bay, Plate } from '@/components/instrument/plate'
import { Lamp, type LampState } from '@/components/instrument/lamp'
import { Rocker } from '@/components/instrument/rocker'
import { StatGrid } from '@/components/instrument/stat-grid'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { DeleteConfirmDialog } from './DeleteConfirmDialog'
import { failText } from './failText'

/*
 * 开机自启清单（可禁用/启用；失效项可删除登记）。
 *
 * 这一页回答的是「开机慢到底谁在拖」和「哪些自启其实早就没用了」。
 * 写入走主进程的 autoapply：这里只把条目 id 递过去，键路径与执行参数由主进程
 * 从刚采集的数据重建 —— 渲染层传的字符串一律不参与拼命令。
 *
 * 状态三档里最容易做错的是「已禁用」：任务管理器禁用过的项路径多半还是好的，
 * 把它归进「失效」会让用户去清一个根本不在跑的东西。所以三档分开，配色也不同。
 */

type Filter = 'all' | 'invalid'

/**
 * 一行条目的状态：正常 / 已禁用 / 路径失效 / 已禁用且路径没了。
 *
 * 第四档不能省：统计块的「路径失效」只算**启用中**的项（禁用着的项路径没了也伤不到人），
 * 若把「已禁用 + 路径没了」也点亮成失效，灯就会比数字多 —— 用户点「仅失效」看到的行数
 * 和上面的读数对不上，两个都在说同一件事却说不到一起。
 */
type RowState = 'ok' | 'disabled' | 'invalid' | 'stale'

const STATE_LAMP: Record<RowState, LampState> = {
  ok: 'ok',
  disabled: 'idle',
  invalid: 'warn',
  // 已禁用的残留：是垃圾但不是故障，走中性色别吓人
  stale: 'idle'
}

const STATE_TEXT: Record<RowState, string> = {
  ok: '正常',
  disabled: '已禁用',
  invalid: '路径失效',
  stale: '已禁用 · 残留'
}

const STATE_TONE: Record<RowState, string> = {
  ok: 'text-faint',
  disabled: 'text-dim',
  invalid: 'text-warn',
  stale: 'text-dim'
}

function rowState(item: StartupItem): RowState {
  // 先判 disabled：它没在跑，路径没了也不会每次开机白跑一次。
  // 这个顺序与统计口径绑死（report.invalid 同样只算启用中的项），改任一边都要一起改。
  if (item.disabled === true) return item.pathExists ? 'disabled' : 'stale'
  return item.pathExists ? 'ok' : 'invalid'
}

const SOURCE_ORDER: readonly StartupSource[] = [
  'registry-hkcu',
  'registry-hklm',
  'registry-hklm-wow',
  'folder-user',
  'folder-common'
]

function Row({
  item,
  busy,
  onToggle,
  onDelete
}: {
  item: StartupItem
  busy: boolean
  onToggle: (item: StartupItem, enabled: boolean) => void
  onDelete: (item: StartupItem) => void
}): JSX.Element {
  const state = rowState(item)
  const enabled = item.disabled !== true
  // 删除入口与主进程的复核口径一致（仅「可判定的路径不存在」）—— 禁用与否不限制
  const deletable = !item.pathExists
  return (
    <div
      data-testid="startup-row"
      data-state={state}
      data-name={item.name}
      className="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0"
    >
      <span className="flex w-[26px] shrink-0 items-center justify-center pt-[3px]">
        {state === 'ok' ? null : <Lamp state={STATE_LAMP[state]} size={7} label={STATE_TEXT[state]} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12.5px]">{item.name}</span>
          {/* 命令行走 .num 等宽：路径是数据，不是正文 */}
          <span
            className="num min-w-0 flex-1 truncate text-[11px] text-faint"
            title={`${item.command}\n${STARTUP_SOURCE_LABEL[item.source]}`}
          >
            {item.command}
          </span>
        </span>
      </span>
      {/* 状态文字定宽右对齐：开关列才排得齐 */}
      <span className={cn('w-[80px] shrink-0 pt-[1px] text-right text-[11px]', STATE_TONE[state])}>
        {STATE_TEXT[state]}
      </span>
      {deletable ? (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 border-danger/45 text-danger hover:bg-danger/10"
          disabled={busy}
          onClick={() => onDelete(item)}
          data-testid="startup-delete"
          data-name={item.name}
        >
          删除
        </Button>
      ) : (
        // 定宽占位：没有删除入口的行也要给这一列留位，开关列才排得齐
        <span className="w-[46px] shrink-0" aria-hidden="true" />
      )}
      <Switch
        size="sm"
        className="mt-[3px]"
        checked={enabled}
        disabled={busy}
        onCheckedChange={(next) => onToggle(item, next)}
        aria-label={`${enabled ? '禁用' : '启用'} ${item.name}`}
        data-testid="startup-toggle"
        data-name={item.name}
        data-checked={enabled ? '1' : '0'}
      />
    </div>
  )
}

export function StartupPanel(): JSX.Element {
  const [report, setReport] = useState<StartupReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  /** 正在写入的条目 id（写操作中该行的开关禁用，防连点） */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 待确认删除的条目（对话框开着时非 null） */
  const [pendingDelete, setPendingDelete] = useState<StartupItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback((force: boolean): void => {
    setLoading(true)
    window.opsCabin
      .listStartup(force)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const handleToggle = useCallback(
    async (item: StartupItem, enabled: boolean): Promise<void> => {
      setBusyId(item.id)
      try {
        const result = await window.opsCabin.applyAutoOp({
          target: 'startup',
          action: 'toggle',
          id: item.id,
          enabled
        })
        if (result.ok) load(true)
        else toast(failText(result))
      } finally {
        setBusyId(null)
      }
    },
    [load]
  )

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = await window.opsCabin.applyAutoOp({
        target: 'startup',
        action: 'delete',
        id: pendingDelete.id
      })
      setPendingDelete(null)
      if (result.ok) toast.success('已删除该条自启登记')
      else toast(failText(result))
      // 成功行消失、失败也可能已被外部改动 —— 两种都强制重读，让页面与真相对齐
      load(true)
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, load])

  const items = report?.items ?? []
  const filtered = useMemo(
    () => (filter === 'invalid' ? items.filter((item) => rowState(item) === 'invalid') : items),
    [items, filter]
  )
  // 按 item.disabled 直接数，不绕 rowState —— 否则「已禁用且路径没了」的项会被漏掉，
  // 而它确实是被禁用的一项
  const disabledCount = items.filter((item) => item.disabled === true).length

  // 按来源分组：注册表三项 + 启动文件夹两项，顺序固定（不按条数排，位置稳定才好找）
  const groups = useMemo(
    () =>
      SOURCE_ORDER.map((source) => ({
        source,
        items: filtered.filter((item) => item.source === source)
      })).filter((group) => group.items.length > 0),
    [filtered]
  )

  return (
    <Plate>
      <Bay
        eyebrow="BOOT · AUTOSTART"
        title="开机自启"
        aside={
          <div className="flex items-center gap-2">
            <Rocker
              size="sm"
              value={filter}
              onChange={setFilter}
              aria-label="筛选自启项"
              options={[
                { value: 'all', label: '全部', testId: 'startup-filter-all' },
                { value: 'invalid', label: '仅失效', testId: 'startup-filter-invalid' }
              ]}
            />
            <Button
              variant="outline"
              size="xs"
              onClick={() => load(true)}
              disabled={loading}
              data-testid="startup-refresh"
            >
              <RefreshCw />
              {loading ? '读取中…' : '重新读取'}
            </Button>
          </div>
        }
        hint={
          report?.error
            ? `读取失败：${report.error}`
            : '开关可直接禁用/启用（本机与公共来源会弹一次 UAC）；路径失效的条目可删除登记 —— 删除只清登记，不碰程序本体。'
        }
      >
        <StatGrid
          data-testid="startup-stats"
          data-total={items.length}
          data-invalid={report?.invalid ?? 0}
          data-disabled={disabledCount}
          cells={[
            { label: '自启项', value: loading && !report ? '—' : `${items.length}` },
            {
              label: '路径失效',
              value: loading && !report ? '—' : `${report?.invalid ?? 0}`,
              danger: (report?.invalid ?? 0) > 0
            },
            { label: '已禁用', value: loading && !report ? '—' : `${disabledCount}` },
            { label: '读于', value: report ? formatClock(report.at) : '—' }
          ]}
        />
      </Bay>

      <Bay eyebrow="LIST" title="自启项清单" pad="none" data-testid="startup-list">
        {filtered.length === 0 ? (
          <div className="px-3.5 pb-4 pt-1 text-[11px] leading-relaxed text-dim">
            {items.length === 0
              ? '没有读到任何自启项 —— 要么这台机器很干净，要么上面的读取失败提示说明了原因。'
              : '没有路径失效的自启项 —— 每一项都还有对应的程序在。'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.source} data-testid="startup-group" data-source={group.source}>
              <div className="flex items-center gap-2 border-y border-line bg-panel-2 px-3.5 py-1.5 first:border-t-0">
                <span className="eyebrow text-dim">{STARTUP_SOURCE_LABEL[group.source]}</span>
                <span className="num ml-auto text-[10.5px] text-faint">
                  {group.items.length} 项
                </span>
              </div>
              {group.items.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onToggle={handleToggle}
                  onDelete={setPendingDelete}
                />
              ))}
            </div>
          ))
        )}
      </Bay>

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        running={deleting}
        title="删除自启登记"
        detail={
          pendingDelete
            ? `将从「${STARTUP_SOURCE_LABEL[pendingDelete.source]}」中删除「${pendingDelete.name}」。此操作不可撤销；只删登记，不碰程序本体。`
            : ''
        }
        testId="startup-delete-confirm"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </Plate>
  )
}
