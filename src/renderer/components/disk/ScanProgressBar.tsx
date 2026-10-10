import type { JSX } from 'react'
import type { ScanProgress } from '@shared/disk'
import { formatCount } from '@shared/format'
import { Lamp } from '@/components/instrument/lamp'

interface Props {
  progress: ScanProgress | null
}

/** 扫描进行中的读数条：相位灯 + 当前路径 + 已浏览文件数 + 不定进度光带（槽面板灰、填充用墨色） */
export function ScanProgressBar({ progress }: Props): JSX.Element {
  const phaseLabel = progress?.phase === 'largeFiles' ? '扫描大文件' : '测量中'
  return (
    <div className="border-b border-line bg-panel px-4 py-2.5" data-testid="scan-progress">
      <div className="flex items-center justify-between gap-4 text-[11px]">
        <span className="flex min-w-0 items-center gap-2">
          <Lamp state="warn" pulse />
          <span className="shrink-0 text-dim">{progress ? phaseLabel : '准备扫描…'}</span>
          <span className="num min-w-0 truncate text-dim" title={progress?.current ?? ''}>
            {progress?.current ?? '…'}
          </span>
        </span>
        <span className="num shrink-0 text-dim">
          已浏览 {formatCount(progress?.scannedFiles ?? 0)} 个文件 · 发现 {progress?.found ?? 0} 项
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="扫描进行中"
        className="relative mt-2 h-1 overflow-hidden rounded-[2px] bg-panel-2"
      >
        <div className="anim-progress h-full w-1/4 bg-fg" />
      </div>
    </div>
  )
}
