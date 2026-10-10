import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Toaster } from 'sonner'
import type { AppInfo } from '@shared/types'
import { cn } from 'cn'
import { Lamp } from './components/instrument/lamp'
import { DiskView } from './views/DiskView'
import { OverviewView } from './views/OverviewView'
import { PortsView } from './views/PortsView'
import { SettingsView } from './views/SettingsView'

const NAV = [
  { key: 'overview', label: '总览', role: 'SYSTEM' },
  { key: 'disk', label: '磁盘', role: 'STORAGE' },
  { key: 'ports', label: '端口', role: 'RADAR' },
  { key: 'settings', label: '设置', role: 'CONFIG' }
] as const

type NavKey = (typeof NAV)[number]['key']

/** 顶栏走时：与各处日志时间戳同源（HH:MM:SS） */
function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    <span className="num text-[12px] text-dim">
      {`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`}
    </span>
  )
}

export function App(): JSX.Element {
  const [view, setView] = useState<NavKey>('overview')
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.opsCabin.getAppInfo().then(setInfo)
  }, [])

  const active = NAV.find((item) => item.key === view)

  return (
    <div className="flex h-full bg-bg text-fg">
      {/* 仪表轨 */}
      <aside className="flex w-[196px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[5px] bg-btn">
            <Lamp state="ok" size={7} />
          </span>
          <div className="min-w-0">
            <div className="text-[14px] font-bold leading-tight tracking-[0.02em]">运维舱</div>
            <div className="eyebrow text-faint">OPS · CABIN</div>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => {
            const isActive = item.key === view
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`nav-${item.key}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setView(item.key)}
                className={cn(
                  'relative flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-left text-[13px] transition-colors duration-150',
                  isActive ? 'bg-sel font-medium text-fg' : 'text-dim hover:bg-panel-2 hover:text-fg'
                )}
              >
                {isActive && (
                  <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-fg" />
                )}
                <Lamp state={isActive ? 'ok' : 'idle'} size={6} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="mt-auto space-y-2 px-4 pb-4">
          <div className="h-px bg-line" />
          <div className="num text-[10px] leading-relaxed text-faint">
            {info ? `v${info.version} · Electron ${info.electron}` : '…'}
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
          <h1 className="text-[15px] font-bold tracking-[0.01em]">{active?.label}</h1>
          <span className="eyebrow pt-0.5 text-faint">{active?.role}</span>
          <div className="ml-auto flex items-center gap-3">
            <Clock />
          </div>
        </header>
        <section className="min-h-0 flex-1">
          {view === 'overview' ? (
            <OverviewView onNavigate={(target) => setView(target)} />
          ) : view === 'disk' ? (
            <DiskView />
          ) : view === 'ports' ? (
            <PortsView />
          ) : (
            <SettingsView />
          )}
        </section>
      </main>

      <Toaster
        theme="system"
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: 'rounded-md border border-line-2 bg-panel text-[12.5px] text-fg',
            description: 'text-dim'
          }
        }}
      />
    </div>
  )
}
