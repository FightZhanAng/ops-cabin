import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { MetricsSample } from '@shared/metrics'
import { formatBytes, formatRate } from '@shared/format'
import { Bay } from '@/components/instrument/plate'
import { SegBar, loadTone } from '@/components/instrument/seg-bar'
import { Sparkline } from '@/components/overview/Sparkline'

/** 系统资源读数：CPU / 内存 / 网络的大字读数 + 走势痕迹（打开页面时订阅推送） */
export function MetricsPanel(): JSX.Element {
  const [sample, setSample] = useState<MetricsSample | null>(null)
  const [cpuSeries, setCpuSeries] = useState<number[]>([])
  const [memSeries, setMemSeries] = useState<number[]>([])
  const [rxSeries, setRxSeries] = useState<number[]>([])

  useEffect(() => {
    let alive = true
    const apply = (next: MetricsSample): void => {
      setSample(next)
      setCpuSeries((prev) => [...prev, next.cpuPercent].slice(-60))
      setMemSeries((prev) =>
        [...prev, next.memTotal > 0 ? (next.memUsed / next.memTotal) * 100 : 0].slice(-60)
      )
      setRxSeries((prev) => [...prev, next.netRxBps ?? 0].slice(-60))
    }
    void window.opsCabin.sampleMetrics().then((first) => {
      if (alive && first) apply(first)
    })
    void window.opsCabin.subscribeMetrics()
    const off = window.opsCabin.onMetricsSample((next) => {
      if (alive) apply(next)
    })
    return () => {
      alive = false
      off()
      void window.opsCabin.unsubscribeMetrics()
    }
  }, [])

  const cpuPercent = sample ? sample.cpuPercent : 0
  const memPercent =
    sample && sample.memTotal > 0
      ? Math.round((sample.memUsed / sample.memTotal) * 1000) / 10
      : 0
  // 网络没有天然满量程：走势线按窗口内峰值自定标（与任务管理器的网络图同一路子）
  const rxPeak = Math.max(...rxSeries, 1) * 1.15

  return (
    <Bay
      eyebrow="SYSTEM"
      title="资源"
      aside={<span className="eyebrow text-faint">1s · 60 点</span>}
      data-testid="metrics-panel"
    >
      <div className="flex flex-col gap-3">
        <div data-testid="metric-cpu">
          <div className="flex items-end gap-3">
            <span className="eyebrow w-8 shrink-0 pb-1 text-dim">CPU</span>
            <Sparkline series={cpuSeries} max={100} className="ml-auto w-[104px] shrink-0" />
            <span className="num shrink-0 text-[24px] font-bold leading-none">
              {sample ? `${sample.cpuPercent}%` : '—'}
            </span>
          </div>
          <SegBar
            ratio={cpuPercent / 100}
            tone={loadTone(cpuPercent)}
            segments={32}
            size="sm"
            className="mt-2"
            aria-label={`CPU ${cpuPercent}%`}
          />
        </div>

        <div data-testid="metric-mem">
          <div className="flex items-end gap-3">
            <span className="eyebrow w-8 shrink-0 pb-1 text-dim">内存</span>
            <Sparkline series={memSeries} max={100} className="ml-auto w-[104px] shrink-0" />
            <span className="num shrink-0 text-[24px] font-bold leading-none">
              {sample ? `${memPercent}%` : '—'}
            </span>
          </div>
          <SegBar
            ratio={memPercent / 100}
            tone={loadTone(memPercent)}
            segments={32}
            size="sm"
            className="mt-2"
            aria-label={`内存 ${memPercent}%`}
          />
          <div className="num mt-1 text-right text-[10.5px] text-faint">
            {sample ? `${formatBytes(sample.memUsed)} / ${formatBytes(sample.memTotal)}` : ''}
          </div>
        </div>

        {/* 网络吞吐：外部命令采样（2s），不是 os 计数器，所以节奏与 CPU/内存不同 */}
        <div data-testid="metric-net" title="网卡吞吐 · 每 2 秒采一次，读数为两次计数之间的平均速率">
          <div className="flex items-end gap-3">
            <span className="eyebrow w-8 shrink-0 pb-1 text-dim">网络</span>
            <Sparkline series={rxSeries} max={rxPeak} className="ml-auto w-[104px] shrink-0" />
            {/* 箭头必须紧贴数字：两个方向共两行，箭头若单独占一行会被读成图例而不是标签 */}
            <span className="flex shrink-0 items-baseline gap-1.5">
              <span className="eyebrow pb-0.5 text-dim">↓</span>
              <span className="num text-[24px] font-bold leading-none">
                {formatRate(sample?.netRxBps ?? null)}
              </span>
            </span>
          </div>
          <div className="num mt-1 text-right text-[10.5px] text-faint">
            ↑ {formatRate(sample?.netTxBps ?? null)}
          </div>
        </div>
      </div>
    </Bay>
  )
}
