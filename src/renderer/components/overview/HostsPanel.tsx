import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatStamp } from '@shared/format'
import type { HostsFlag, HostsReport } from '@shared/hosts'
import { Lamp, type LampState } from '@/components/instrument/lamp'
import { Button } from '@/components/ui/button'

/*
 * hosts 文件体检（只读）。
 *
 * 与联网体检是配套的两半：那边说「github.com 解析到 127.0.0.1」，这边说
 * **是谁改的**。少了这一半，用户知道症状却找不到病灶 —— 而 hosts 文件
 * 平时没人会主动去看。
 *
 * 判定只报三件确定的事（指向本机 / 被屏蔽 / 命中发布链路域名），局域网映射
 * 一律不报：报得越宽，真正要看的那几条越容易被淹掉。
 */

const KIND_TEXT: Record<HostsFlag['kind'], string> = {
  loopback: '指向本机',
  null: '被屏蔽',
  other: '被改写'
}

const KIND_LAMP: Record<HostsFlag['kind'], LampState> = {
  loopback: 'warn',
  null: 'ink',
  other: 'warn'
}

function FlagRow({ flag }: { flag: HostsFlag }): JSX.Element {
  // 命中发布链路域名的一律用 warn：那几条直接决定这台机器能不能发版
  const state: LampState = flag.watched ? 'warn' : KIND_LAMP[flag.kind]
  return (
    <div
      data-testid="hosts-flag"
      data-kind={flag.kind}
      data-watched={flag.watched ? 'true' : 'false'}
      className="flex items-center gap-2.5 border-b border-line px-3.5 py-1.5 last:border-b-0"
    >
      <Lamp state={state} size={7} label={KIND_TEXT[flag.kind]} />
      {/*
        「第 N 行」必须一行放得下：固定 52px 时它会折成两行 —— 行高不齐，而且
        数字列的左缘再也对不上，扫一列数字变成扫一段文字。用 min-w + nowrap：
        短数字对齐，万一行号特别长也不会被截断或折行。
      */}
      <span className="num min-w-[68px] shrink-0 whitespace-nowrap text-[10.5px] text-faint">
        第 {flag.line} 行
      </span>
      <span
        className="num min-w-0 flex-1 truncate text-[11.5px]"
        title={`${flag.hostname} → ${flag.ip}`}
      >
        {flag.hostname} <span className="text-faint">→</span> {flag.ip}
      </span>
      <span
        className={
          flag.watched ? 'shrink-0 text-[11px] text-warn' : 'shrink-0 text-[11px] text-dim'
        }
      >
        {KIND_TEXT[flag.kind]}
        {flag.watched ? ' · 发布链路' : ''}
      </span>
    </div>
  )
}

export function HostsPanel(): JSX.Element {
  const [report, setReport] = useState<HostsReport | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback((): void => {
    setLoading(true)
    window.opsCabin
      .readHosts()
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const flags = report?.flags ?? []
  const watched = flags.filter((flag) => flag.watched).length

  return (
    <div
      data-testid="hosts-panel"
      data-flags={flags.length}
      data-watched={watched}
      data-omitted={report?.omitted ?? 0}
      data-readable={report ? (report.readable ? 'true' : 'false') : 'unknown'}
    >
      <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-0.5">
        <span className="num min-w-0 flex-1 truncate text-[11px] text-dim" title={report?.path}>
          {report
            ? report.readable
              ? `${report.path} · 共 ${report.totalLines} 行 · 生效 ${report.entries} 条${
                  report.modifiedAt ? ` · 改于 ${formatStamp(report.modifiedAt)}` : ''
                }`
              : `${report.path} · ${report.error ?? '读不到'}`
            : '正在读取 hosts 文件……'}
        </span>
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={load}
          disabled={loading}
          data-testid="hosts-refresh"
        >
          <RefreshCw />
          {loading ? '读取中…' : '重新读取'}
        </Button>
      </div>

      {flags.length === 0 ? (
        <div className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-dim">
          {report && !report.readable
            ? '读不到 hosts 文件 —— 上面的原因说明拦在哪一步。'
            : 'hosts 里没有被改写的域名 —— 所有域名都走真实 DNS 解析。'}
        </div>
      ) : (
        <div className="max-h-[210px] overflow-auto border-t border-line">
          {flags.map((flag) => (
            <FlagRow key={`${flag.line}-${flag.hostname}`} flag={flag} />
          ))}
          {report && report.omitted > 0 && (
            <div className="num border-t border-line bg-panel-2 px-3.5 py-1.5 text-[10.5px] text-faint">
              另有 {report.omitted} 条未列出（按「发布链路优先」排序后截断）
            </div>
          )}
        </div>
      )}
    </div>
  )
}
