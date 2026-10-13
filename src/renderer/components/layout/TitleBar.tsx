import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { cn } from 'cn'
import type { AppInfo } from '@shared/types'
import { AboutMenu } from './AboutMenu'

/*
 * 自绘标题栏（主进程 frame:false，系统标题栏整条不存在了）。
 *
 * 三条硬约束：
 *   1) 拖拽用原生 -webkit-app-region:drag（跟手、且保留 Windows 贴边吸附），
 *      按钮区必须 no-drag，否则点不到；
 *   2) 图标跟着 maximized 状态切换（Square=最大化，Copy=还原），
 *      状态由主进程 win:state 推送，不猜；
 *   3) 左侧不再是 logo + 应用名（那是侧栏的活儿，重复了），
 *      只放「关于」入口：版本号 / 检查更新 / 退出。
 */

/** 窗口控制按钮的公共样式：Windows caption 键是方的，这里压成 3px 方角（仪器是方的） */
const CONTROL_BASE =
  'flex h-8 w-11 cursor-pointer items-center justify-center rounded-sm text-dim transition-colors duration-150'

interface Props {
  info: AppInfo | null
  /** 「关于 · 发现新版本」时跳到设置页的更新分区 */
  onOpenUpdate: () => void
}

export function TitleBar({ info, onOpenUpdate }: Props): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // 初始态查一次，之后跟推送
    void window.opsCabin.getWindowState().then((state) => setMaximized(state.maximized))
    return window.opsCabin.onWindowState((state) => setMaximized(state.maximized))
  }, [])

  const toggleMaximize = (): void => {
    void window.opsCabin.toggleMaximizeWindow()
  }

  return (
    <div
      data-testid="titlebar"
      className="titlebar-drag flex h-9 shrink-0 select-none items-center border-b border-line bg-bg"
    >
      {/* 左：关于（不可拖，双击不触发最大化） */}
      <div className="titlebar-no-drag flex items-center pl-1">
        <AboutMenu info={info} onOpenUpdate={onOpenUpdate} />
      </div>

      {/* 中：拖拽区；双击 = 最大化/还原（frame:false 没有原生双击行为） */}
      <div className="min-w-0 flex-1 self-stretch" onDoubleClick={toggleMaximize} />

      {/* 右：窗口控制（不可拖） */}
      <div className="titlebar-no-drag flex items-center pr-1">
        <button
          type="button"
          data-testid="win-minimize"
          aria-label="最小化"
          title="最小化"
          onClick={() => void window.opsCabin.minimizeWindow()}
          className={cn(CONTROL_BASE, 'hover:bg-panel-2 hover:text-fg')}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          data-testid="win-maximize"
          aria-label={maximized ? '还原' : '最大化'}
          title={maximized ? '还原' : '最大化'}
          onClick={toggleMaximize}
          className={cn(CONTROL_BASE, 'hover:bg-panel-2 hover:text-fg')}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          type="button"
          data-testid="win-close"
          aria-label="关闭"
          title="关闭（隐藏到托盘）"
          onClick={() => void window.opsCabin.closeWindow()}
          className={cn(CONTROL_BASE, 'hover:bg-danger-soft hover:text-white')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

