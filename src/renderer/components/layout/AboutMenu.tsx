import { useState } from 'react'
import type { JSX } from 'react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { ChevronRight, Info, Power, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import type { AppInfo } from '@shared/types'
import type { UpdateState } from '@shared/update'
import { AboutDialog } from './AboutDialog'

/*
 * 标题栏左上的「关于」下拉：版本（点开弹窗）/ 检查更新 / 退出。
 *
 * 更新检查的状态机在主进程（三段式：检查 → 下载 → 安装），这里只做两件事：
 * 触发检查，等状态落到终态后把结果报出来。安装仍在设置页由用户手动点。
 */

interface Props {
  info: AppInfo | null
  /** 「发现新版本」时把用户送到设置页的更新分区 */
  onOpenUpdate: () => void
}

/** 同一个 toast id：加载态被终态替换，不会堆一屏 */
const TOAST_ID = 'about-update-check'
const CHECK_TIMEOUT_MS = 20000

const ITEM_CLASS = cn(
  'flex h-8 cursor-pointer select-none items-center gap-2 px-3 text-[12.5px] outline-none',
  'data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg'
)

function toastResult(state: UpdateState, onOpenUpdate: () => void): void {
  switch (state.status) {
    case 'available':
      toast(`发现新版本 v${state.latest}`, {
        id: TOAST_ID,
        description: '到「设置 · 版本更新」里下载。',
        action: { label: '去下载', onClick: onOpenUpdate }
      })
      break
    case 'error':
      toast.error('检查更新失败', { id: TOAST_ID, description: state.message || undefined })
      break
    case 'unsupported':
      toast('当前运行方式不支持自动更新', { id: TOAST_ID, description: '可以到发布页手动下载。' })
      break
    case 'downloaded':
      toast('新版本已下载', { id: TOAST_ID, description: '去设置里重启并安装。' })
      break
    default:
      toast('已是最新版本', { id: TOAST_ID, description: `当前 v${state.current}` })
  }
}

function runCheck(onOpenUpdate: () => void): void {
  toast.loading('正在检查更新…', { id: TOAST_ID })

  let off: (() => void) | null = null
  let timer = 0
  const finish = (state?: UpdateState): void => {
    if (off) {
      off()
      off = null
    }
    window.clearTimeout(timer)
    if (state) toastResult(state, onOpenUpdate)
  }

  off = window.opsCabin.onUpdate((state) => {
    // checking 只是中间态，等终态再报
    if (state.status !== 'checking') finish(state)
  })
  timer = window.setTimeout(() => {
    const pending = off !== null
    finish()
    if (pending) {
      toast.error('检查更新超时', { id: TOAST_ID, description: '网络可能不通，稍后可以再试。' })
    }
  }, CHECK_TIMEOUT_MS)

  void window.opsCabin
    .checkUpdate()
    .then((state) => {
      // 返回值若已经是终态（例如刚被别处检查过），直接出结果
      if (state && state.status !== 'checking') finish(state)
    })
    .catch(() => {
      finish()
      toast.error('更新检查未就绪', { id: TOAST_ID })
    })
}

/** 「关于」菜单：版本（点开弹窗）/ 检查更新 / 退出 */
export function AboutMenu({ info, onOpenUpdate }: Props): JSX.Element {
  const [aboutOpen, setAboutOpen] = useState(false)

  return (
    <>
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <button
            type="button"
            data-testid="about-menu"
            aria-label="关于"
            title="关于"
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-[12px] text-dim transition-colors duration-150 outline-none hover:bg-panel-2 hover:text-fg data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
          >
            <Info size={13} />
            关于
          </button>
        </DropdownMenuPrimitive.Trigger>

        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="start"
            sideOffset={6}
            data-testid="about-menu-content"
            // 从菜单里开弹窗：菜单关闭时不要把焦点抢回触发器，焦点该归弹窗
            onCloseAutoFocus={(event) => event.preventDefault()}
            className="z-50 min-w-[226px] rounded-md border border-line-2 bg-panel py-1 text-fg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            <div className="px-3 pb-1.5 pt-1.5">
              <div className="text-[12.5px] font-bold">{info?.name ?? '运维舱'}</div>
            </div>

            <DropdownMenuPrimitive.Separator className="h-px bg-line" />

            <div className="pt-1">
              <DropdownMenuPrimitive.Item
                data-testid="about-item-version"
                className={cn(ITEM_CLASS, 'justify-between')}
                onSelect={() => setAboutOpen(true)}
              >
                <span className="flex items-center gap-2">
                  <Info size={13} className="shrink-0 text-dim" />
                  版本
                  <span className="num text-[11.5px] text-dim" data-testid="about-version">
                    v{info?.version ?? '…'}
                  </span>
                </span>
                <ChevronRight size={13} className="shrink-0 text-faint" />
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                data-testid="about-item-check"
                className={ITEM_CLASS}
                onSelect={() => runCheck(onOpenUpdate)}
              >
                <RefreshCw size={13} className="shrink-0 text-dim" />
                检查更新
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                data-testid="about-item-quit"
                className={ITEM_CLASS}
                onSelect={() => void window.opsCabin.quit()}
              >
                <Power size={13} className="shrink-0 text-dim" />
                退出
              </DropdownMenuPrimitive.Item>
            </div>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>

      <AboutDialog info={info} open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  )
}
