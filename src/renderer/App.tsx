import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Toaster } from 'sonner'
import type { AppInfo } from '@shared/types'
import { DiskView } from './views/DiskView'
import { OverviewView } from './views/OverviewView'
import { PortsView } from './views/PortsView'
import { SettingsView } from './views/SettingsView'

const NAV = [
  { key: 'overview', label: '总览' },
  { key: 'disk', label: '磁盘' },
  { key: 'ports', label: '端口' },
  { key: 'settings', label: '设置' }
] as const

type NavKey = (typeof NAV)[number]['key']

export function App(): JSX.Element {
  const [view, setView] = useState<NavKey>('overview')
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.opsCabin.getAppInfo().then(setInfo)
  }, [])

  return (
    <div className="flex h-full bg-bg text-fg">
      {/* 侧栏 */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-4 pb-4 pt-5">
          <div className="text-[15px] font-semibold tracking-wide">运维舱</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
            Ops Cabin
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => {
            const active = item.key === view
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`nav-${item.key}`}
                onClick={() => setView(item.key)}
                className={
                  'cursor-pointer rounded-md px-3 py-1.5 text-left text-[13px] transition-colors duration-150 ' +
                  (active
                    ? 'bg-panel-2 font-medium text-signal'
                    : 'text-dim hover:bg-panel-2 hover:text-fg')
                }
              >
                {item.label}
              </button>
            )
          })}
        </nav>

        <div className="mt-auto px-4 pb-4 font-mono text-[10px] leading-relaxed text-dim">
          {info ? `v${info.version}` : '…'}
          <br />
          {info ? `Electron ${info.electron}` : ''}
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center border-b border-line px-6 py-4">
          <h1 className="text-[17px] font-semibold">
            {NAV.find((item) => item.key === view)?.label}
          </h1>
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

      <Toaster theme="system" position="bottom-right" />
    </div>
  )
}
