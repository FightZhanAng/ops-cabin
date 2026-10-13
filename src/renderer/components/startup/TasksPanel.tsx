import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { formatClock, formatStamp } from '@shared/format'
import {
  TASK_TRIGGER_LABEL,
  taskFolderLabel,
  type TaskItem,
  type TaskReport,
  type TaskState
} from '@shared/tasks'
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
 * 计划任务清单（可禁用/启用；路径失效的可删除登记）。
 *
 * 这一页回答的是「开机自启清单之外，还有谁在后台按时跑」—— 开机自启只覆盖三个
 * Run 键和两个启动文件夹，真正的大头（遥测上报、自动更新、定时联网）都在
 * 任务计划程序里。
 *
 * 写入走主进程的 autoapply（与启动项页同一入口）：这里只把任务 id（全路径）
 * 递过去，执行参数由主进程从自采集数据重建 —— 渲染层传的字符串不参与拼命令。
 *
 * 统计块与行上的灯必须同一套判据，否则用户点「仅需留意」看到的行数和上面的读数
 * 对不上 —— 上一批在启动项页踩过这个坑（灯比数字多），这里从设计上就只留一个谓词：
 * needsAttention()。report.attention 由主进程按同一条件算，e2e 会断言两者相等。
 */

type Filter = 'all' | 'attention' | 'disabled'

const STATE_LAMP: Record<TaskState, LampState> = {
  ok: 'ok',
  // 「已禁用」不算异常 —— 服务、自启项、设备之后第四次遇到同一条纪律
  disabled: 'idle',
  failing: 'warn',
  missing: 'warn'
}

const STATE_TEXT: Record<TaskState, string> = {
  ok: '正常',
  disabled: '已禁用',
  failing: '上次失败',
  missing: '路径失效'
}

const STATE_TONE: Record<TaskState, string> = {
  ok: 'text-faint',
  disabled: 'text-dim',
  failing: 'text-warn',
  missing: 'text-warn'
}

/** 「需要留意」的唯一判据（与主进程的 report.attention 同源） */
function needsAttention(item: TaskItem): boolean {
  return item.state === 'failing' || item.state === 'missing'
}

/** 触发类型的短标签；没有触发器的任务不会自己跑，标成「手动」 */
function triggerText(item: TaskItem): string {
  if (item.triggers.length === 0) return '手动'
  return item.triggers.map((trigger) => TASK_TRIGGER_LABEL[trigger]).join(' · ')
}

function Row({
  item,
  busy,
  onToggle,
  onDelete
}: {
  item: TaskItem
  busy: boolean
  onToggle: (item: TaskItem, enabled: boolean) => void
  onDelete: (item: TaskItem) => void
}): JSX.Element {
  // 正在运行时以「现在」为准：LastTaskResult 此刻也是「正在运行」，但 running
  // 是权威的实时状态，不必依赖结果码
  const resultText = item.running ? '正在运行' : (item.lastResult?.text ?? '尚未运行')
  /*
   * 下次运行时间只在「真的会有下次」时才印出来：
   *   · 登录触发 / 开机触发的任务没有排期，NextRunTime 是空的 —— 印成「下次 —」
   *     会让人以为它坏了，而它本来就该等着登录时跑；
   *   · 已禁用的任务可能还留着一个陈旧的 NextRunTime，但它不会在那个点跑，
   *     印出来等于告诉用户「今晚会动」。
   * 两种情况都省略；完整信息留在 title 里备查。
   */
  const showNext = item.state !== 'disabled' && item.nextRunAt !== null
  const nextText = item.nextRunAt !== null ? formatStamp(item.nextRunAt) : '—'
  const enabled = item.state !== 'disabled'
  // 删除入口与主进程的复核口径一致（S9：仅「路径失效」档）
  const deletable = item.state === 'missing'
  return (
    <div
      data-testid="task-row"
      data-state={item.state}
      data-name={item.name}
      data-running={item.running ? '1' : '0'}
      data-triggers={item.triggers.join(',')}
      className="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0"
    >
      <span className="flex w-[26px] shrink-0 items-center justify-center pt-[3px]">
        {item.state === 'ok' ? null : (
          <Lamp state={STATE_LAMP[item.state]} size={7} label={STATE_TEXT[item.state]} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12.5px]">{item.name}</span>
          <span
            className="shrink-0 text-[10.5px] text-dim"
            title={item.author !== null ? `作者：${item.author}` : undefined}
          >
            {triggerText(item)}
            {item.hasUnknownTrigger ? ' · 其他' : ''}
          </span>
        </span>
        {/* 命令行走 .num 等宽：路径是数据，不是正文 */}
        <span
          className="num mt-0.5 block min-w-0 truncate text-[11px] text-faint"
          title={item.action ?? '这个任务没有「执行程序」类动作'}
        >
          {item.action ?? '（没有可执行的动作）'}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className={cn('block text-[11px]', STATE_TONE[item.state])}>
          {STATE_TEXT[item.state]}
        </span>
        <span
          className="num block whitespace-nowrap text-[10.5px] text-faint"
          title={`上次运行结果：${item.lastResult?.text ?? '尚未运行'}\n下次运行：${nextText}`}
        >
          {resultText}
          {showNext ? ` · 下次 ${nextText}` : ''}
        </span>
      </span>
      {deletable ? (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 border-danger/45 text-danger hover:bg-danger/10"
          disabled={busy}
          onClick={() => onDelete(item)}
          data-testid="task-delete"
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
        data-testid="task-toggle"
        data-name={item.name}
        data-checked={enabled ? '1' : '0'}
      />
    </div>
  )
}

export function TasksPanel(): JSX.Element {
  const [report, setReport] = useState<TaskReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  /** 正在写入的任务 id（写操作中该行的开关禁用，防连点） */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 待确认删除的任务（对话框开着时非 null） */
  const [pendingDelete, setPendingDelete] = useState<TaskItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback((force: boolean): void => {
    setLoading(true)
    window.opsCabin
      .listTasks(force)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false))
  }, [])

  // 只在真的切到这一档时才采集：这份数据要起一次 COM 枚举（本机 1.5 秒），
  // 用户没点进来就不该替他花这个时间。主进程侧还有 60 秒 TTL 兜住来回切。
  useEffect(() => {
    load(false)
  }, [load])

  const handleToggle = useCallback(
    async (item: TaskItem, enabled: boolean): Promise<void> => {
      setBusyId(item.id)
      try {
        const result = await window.opsCabin.applyAutoOp({
          target: 'task',
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
        target: 'task',
        action: 'delete',
        id: pendingDelete.id
      })
      setPendingDelete(null)
      if (result.ok) toast.success('已删除该条任务定义')
      else toast(failText(result))
      // 成功行消失、失败也可能已被外部改动 —— 两种都强制重读，让页面与真相对齐
      load(true)
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, load])

  const items = report?.items ?? []
  const filtered = useMemo(() => {
    if (filter === 'attention') return items.filter(needsAttention)
    if (filter === 'disabled') return items.filter((item) => item.state === 'disabled')
    return items
  }, [items, filter])

  // 按文件夹分组：顺序沿用采集器的排序（根目录在前），不按条数重排 ——
  // 位置稳定才好找，条数一变顺序就跳会让人找不到刚才那一行
  const groups = useMemo(() => {
    const bucketed = new Map<string, TaskItem[]>()
    for (const item of filtered) {
      const bucket = bucketed.get(item.folder)
      if (bucket) bucket.push(item)
      else bucketed.set(item.folder, [item])
    }
    return [...bucketed].map(([folder, list]) => ({ folder, items: list }))
  }, [filtered])

  const emptyText =
    items.length === 0
      ? '没有读到非系统计划任务 —— 要么这台机器真没有，要么上面的读取失败提示说明了原因。'
      : filter === 'attention'
        ? '没有需要留意的任务 —— 启用中的任务路径都在、上次运行也都正常。'
        : '没有已禁用的任务。'

  return (
    <Plate>
      <Bay
        eyebrow="SCHEDULE · TASKS"
        title="计划任务"
        aside={
          <div className="flex items-center gap-2">
            <Rocker
              size="sm"
              value={filter}
              onChange={setFilter}
              aria-label="筛选计划任务"
              options={[
                { value: 'all', label: '全部', testId: 'tasks-filter-all' },
                { value: 'attention', label: '仅需留意', testId: 'tasks-filter-attention' },
                { value: 'disabled', label: '已禁用', testId: 'tasks-filter-disabled' }
              ]}
            />
            <Button
              variant="outline"
              size="xs"
              onClick={() => load(true)}
              disabled={loading}
              data-testid="tasks-refresh"
            >
              <RefreshCw />
              {loading ? '读取中…' : '重新读取'}
            </Button>
          </div>
        }
        hint={
          report?.error
            ? `读取失败：${report.error}`
            : '开关可直接禁用/启用；任务改不动时会弹一次 UAC（用户自建的任务通常不需要）。系统自带的任务已跳过，它们由 Windows 自己管。'
        }
      >
        <StatGrid
          data-testid="tasks-stats"
          data-total={items.length}
          data-attention={report?.attention ?? 0}
          data-disabled={items.filter((i) => i.state === 'disabled').length}
          data-scanned={report?.scanned ?? 0}
          data-skipped={report?.systemSkipped ?? 0}
          cells={[
            { label: '计划任务', value: loading && !report ? '—' : `${items.length}` },
            {
              label: '需留意',
              value: loading && !report ? '—' : `${report?.attention ?? 0}`,
              danger: (report?.attention ?? 0) > 0
            },
            {
              label: '已禁用',
              value: loading && !report ? '—' : `${items.filter((i) => i.state === 'disabled').length}`
            },
            {
              label: '跳过系统',
              value: loading && !report ? '—' : `${report?.systemSkipped ?? 0}`
            }
          ]}
        />
        <div className="mt-2 flex items-baseline gap-2 text-[10.5px] text-faint">
          <span className="num">
            全机 {report?.scanned ?? 0} 个任务 · 读于{' '}
            {report ? formatClock(report.at) : '—'}
            {report ? ` · ${report.durationMs}ms` : ''}
          </span>
        </div>
      </Bay>

      <Bay eyebrow="LIST" title="任务清单" pad="none" data-testid="tasks-list">
        {filtered.length === 0 ? (
          <div className="px-3.5 pb-4 pt-1 text-[11px] leading-relaxed text-dim">{emptyText}</div>
        ) : (
          groups.map((group) => (
            <div key={group.folder} data-testid="task-group" data-folder={group.folder}>
              <div className="flex items-center gap-2 border-y border-line bg-panel-2 px-3.5 py-1.5 first:border-t-0">
                <span className="eyebrow truncate text-dim" title={group.folder}>
                  {taskFolderLabel(group.folder)}
                </span>
                <span className="num ml-auto shrink-0 text-[10.5px] text-faint">
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
        title="删除计划任务"
        detail={
          pendingDelete
            ? `将从任务计划程序中删除「${pendingDelete.name}」。此操作不可撤销；只删任务定义，不碰程序本体。`
            : ''
        }
        testId="task-delete-confirm"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </Plate>
  )
}
