import { useState } from 'react'
import type { JSX } from 'react'
import { Activity } from 'lucide-react'
import type { NetCheckItem, NetCheckReport } from '@shared/net'
import { Button } from '@/components/ui/button'
import { Lamp, type LampState } from '@/components/instrument/lamp'

/*
 * 联网体检：把「这次失败是网络还是代码」在几秒内回答掉。
 *
 * 不用 SegBar / 百分比之类的仪表 —— 每个探针的结论是「通 / 不通」这种离散事实，
 * 用仪表灯 + 一句话（自带数字）最贴。代理那一条是读数不是好坏，用 idle 灯。
 */

const STATE_LAMP: Record<NetCheckItem['state'], LampState> = {
  ok: 'ok',
  fail: 'danger',
  info: 'idle'
}

const STATE_TEXT: Record<NetCheckItem['state'], string> = {
  ok: '通',
  fail: '不通',
  info: '读数'
}

function Row({ item }: { item: NetCheckItem }): JSX.Element {
  return (
    // items-start + 统一 leading：证据最多两行，行高要跟标签首行对齐
    <div
      data-testid="netcheck-item"
      className="flex items-start gap-2.5 border-b border-line px-3.5 py-1.5 last:border-b-0"
    >
      <Lamp
        state={STATE_LAMP[item.state]}
        size={7}
        label={STATE_TEXT[item.state]}
        className="mt-[4px]"
      />
      <span className="w-[86px] shrink-0 text-[12px] font-medium leading-4">{item.label}</span>
      {/* 不 truncate：这段是判据本身（「已连通 · 抓取」「证书不受信任但通道可用」），
          截掉半句就只剩结论没有依据。面板只占一行 Plate 的 2/5，最长的判据要三行
          才放得下，故上限给三行；完整原文留在 title 里。 */}
      <span
        className="num line-clamp-3 min-w-0 flex-1 text-[11px] leading-4 text-dim"
        title={item.detail}
      >
        {item.detail}
      </span>
      <span className="num w-[52px] shrink-0 text-right text-[11px] leading-4 text-faint">
        {item.ms === null ? '—' : `${item.ms} ms`}
      </span>
    </div>
  )
}

export function NetCheckPanel(): JSX.Element {
  const [report, setReport] = useState<NetCheckReport | null>(null)
  const [running, setRunning] = useState(false)

  const run = (): void => {
    if (running) return
    setRunning(true)
    window.opsCabin
      .runNetCheck()
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setRunning(false))
  }

  // 「读数」项（API 证书不受信任但通道可用、代理配置）不计入通过数 —— 说出来，
  // 否则 6 行结论配「3 / 4 项通过」会让人以为漏算了。
  const readouts = report ? report.items.filter((item) => item.state === 'info').length : 0

  return (
    <div data-testid="netcheck-panel" data-running={running} data-passed={report?.passed ?? -1}>
      <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-0.5">
        <span className="num text-[11px] text-dim">
          {running
            ? '探测中 —— DNS、443、22、SSH-over-443、API 与代理并行发问，约 5 秒'
            : report
              ? `${report.passed} / ${report.total} 项通过${readouts > 0 ? ` · ${readouts} 项读数` : ''}`
              : '还没体检过'}
        </span>
        <Button
          variant={report === null ? 'default' : 'outline'}
          size="xs"
          className="ml-auto"
          onClick={run}
          disabled={running}
          data-testid="netcheck-run"
        >
          <Activity />
          {running ? '探测中…' : report ? '再测一次' : '开始体检'}
        </Button>
      </div>

      {report === null ? (
        <div className="px-3.5 pb-3 text-[11px] leading-relaxed text-dim">
          {running
            ? '正在探测本机的发布链路……'
            : '点右上角开始：会依次探测域名解析、GitHub 的 443 与 22 端口、SSH-over-443 备用通道、API 可达性与代理设置。'}
        </div>
      ) : (
        <div className="border-t border-line">
          {report.items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
