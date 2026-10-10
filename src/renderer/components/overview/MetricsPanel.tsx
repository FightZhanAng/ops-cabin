import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { MetricsSample } from '@shared/metrics'
import { formatBytes } from '@shared/format'
import { Sparkline } from '@/components/overview/Sparkline'

/** 总览的资源读数：CPU / 内存 KPI 大字 + 走势线（打开页面时订阅 1s 推送） */
export function MetricsPanel(): JSX.Element {
  const [sample, setSample] = useState<MetricsSample | null>(null)
  const [cpuSeries, setCpuSeries] = useState<number[]>([])
  const [memSeries, setMemSeries] = useState<number[]>([])

  useEffect(() => {
    let alive = true
    const apply = (next: MetricsSample): void => {
      setSample(next)
      setCpuSeries((prev) => [...prev, next.cpuPercent].slice(-60))
      setMemSeries((prev) => [
        ...prev,
        next.memTotal > 0 ? (next.memUsed / next.memTotal) * 100 : 0
      ].slice(-60))
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

  const memPercent = sample && sample.memTotal > 0
    ? Math.round((sample.memUsed / sample.memTotal) * 1000) / 10
    : 0

  return (
    <section className="rounded-[10px] border border-line bg-panel p-4" data-testid="metrics-panel">
      <h2 className="text-[13px] font-semibold">资源</h2>

      <div className="mt-3 space-y-4">
        <div data-testid="metric-cpu">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-dim">CPU</span>
            <span className="font-mono text-[22px] font-semibold leading-none tabular-nums">
              {sample ? `${sample.cpuPercent}%` : '—'}
            </span>
          </div>
          <Sparkline series={cpuSeries} max={100} />
        </div>

        <div data-testid="metric-mem">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-dim">内存</span>
            <span className="font-mono text-[22px] font-semibold leading-none tabular-nums">
              {sample ? `${memPercent}%` : '—'}
            </span>
          </div>
          <div className="text-right font-mono text-[10px] text-dim tabular-nums">
            {sample ? `${formatBytes(sample.memUsed)} / ${formatBytes(sample.memTotal)}` : ''}
          </div>
          <Sparkline series={memSeries} max={100} />
        </div>
      </div>
    </section>
  )
}
