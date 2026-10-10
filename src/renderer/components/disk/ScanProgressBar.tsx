import type { JSX } from 'react'
import type { ScanProgress } from '@shared/disk'
import { formatCount } from '@shared/format'

interface Props {
  progress: ScanProgress | null
}

/** 扫描进行中的状态条：当前路径 + 已浏览文件数 + 不定进度动画 */
export function ScanProgressBar({ progress }: Props): JSX.Element {
  const phaseLabel = progress?.phase === 'largeFiles' ? '扫描大文件' : '测量中'
  return (
    <div className="border-b border-line bg-panel/50 px-4 py-2.5" data-testid="scan-progress">
      <div className="flex items-center justify-between gap-4 text-[11px]">
        <span className="min-w-0 truncate text-dim" title={progress?.current ?? ''}>
          {progress ? `${phaseLabel}：${progress.current}` : '准备扫描…'}
        </span>
        <span className="shrink-0 font-mono text-dim">
          已浏览 {formatCount(progress?.scannedFiles ?? 0)} 个文件 · 发现 {progress?.found ?? 0} 项
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-2">
        <div className="anim-progress h-full w-1/4 rounded-full bg-signal" />
      </div>
    </div>
  )
}
