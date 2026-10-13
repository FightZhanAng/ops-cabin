import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import {
  Activity,
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  HardDrive,
  Power,
  Radar,
  Settings as SettingsIcon
} from 'lucide-react'
import { Toaster } from 'sonner'
import type { AppInfo, ThemeMode } from '@shared/types'
import { cn } from 'cn'
import { Lamp } from './components/instrument/lamp'
import { ThemeSwitch } from './components/layout/ThemeSwitch'
import { TitleBar } from './components/layout/TitleBar'
import { type NavBadge, type SidebarStatus, useSidebarStatus } from './components/layout/useSidebarStatus'
import { DiskView } from './views/DiskView'
import { HealthView } from './views/HealthView'
import { OverviewView } from './views/OverviewView'
import { PortsView } from './views/PortsView'
import { SettingsView } from './views/SettingsView'
import { StartupView } from './views/StartupView'

const NAV = [
  { key: 'overview', label: '总览', role: 'SYSTEM', icon: Gauge },
  { key: 'disk', label: '磁盘', role: 'STORAGE', icon: HardDrive },
  { key: 'ports', label: '端口', role: 'RADAR', icon: Radar },
  { key: 'startup', label: '启动项', role: 'BOOT', icon: Power },
  { key: 'health', label: '体检', role: 'HEALTH', icon: Activity },
  { key: 'settings', label: '设置', role: 'CONFIG', icon: SettingsIcon }
] as const

type NavKey = (typeof NAV)[number]['key']

/** 徽标配色：只有真信号用信号色，常态读数走墨阶 */
const BADGE_TEXT: Record<NavBadge['tone'], string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  idle: 'text-faint'
}

const BADGE_DOT: Record<NavBadge['tone'], string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  idle: 'bg-line-2'
}

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
  // 侧栏收起态持久化在设置里（收起后只显示图标）
  const [collapsed, setCollapsed] = useState(false)
  // 主题选择（'system' | 'light' | 'dark'）：只存选择值，配色仍由 prefers-color-scheme 跟随
  const [theme, setTheme] = useState<ThemeMode>('system')

  useEffect(() => {
    let alive = true
    void window.opsCabin.getAppInfo().then((next) => {
      if (alive) setInfo(next)
    })
    void window.opsCabin.getSettings().then((settings) => {
      if (!alive || !settings) return
      setTheme(settings.theme)
      setCollapsed(settings.sidebarCollapsed)
    })
    // 主进程侧的改动（设置页、托盘、自检）推过来：两处控件不许各说各话
    const off = window.opsCabin.onSettings((settings) => {
      setTheme(settings.theme)
      setCollapsed(settings.sidebarCollapsed)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const toggleSidebar = (): void => {
    const next = !collapsed
    setCollapsed(next)
    void window.opsCabin.updateSettings({ sidebarCollapsed: next })
  }

  const changeTheme = (mode: ThemeMode): void => {
    setTheme(mode)
    void window.opsCabin.updateSettings({ theme: mode })
  }

  const active = NAV.find((item) => item.key === view)
  // 侧栏常驻状态：切页时重新拉一次，读数跟着页面走
  const status = useSidebarStatus(view)

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* 自绘标题栏：占满窗口宽，整条可拖动（主进程 frame:false，没有系统标题栏了） */}
      <TitleBar info={info} onOpenUpdate={() => setView('settings')} />

      <div className="flex min-h-0 flex-1">
        {/* 仪表轨：可收起为图标态 */}
        <aside
          data-testid="sidebar"
          data-collapsed={collapsed ? 'true' : 'false'}
          className={cn(
            'flex shrink-0 flex-col overflow-hidden border-r border-line bg-panel transition-[width] duration-200',
            collapsed ? 'w-12' : 'w-[196px]'
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2.5',
              collapsed ? 'justify-center pb-3 pt-4' : 'px-4 pb-4 pt-5'
            )}
          >
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[5px] bg-btn">
              <Lamp state="ok" size={7} />
            </span>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[14px] font-bold leading-tight tracking-[0.02em]">运维舱</div>
                <div className="eyebrow text-faint">OPS · CABIN</div>
              </div>
            )}
          </div>

          <nav className={cn('flex flex-col gap-0.5', collapsed ? 'px-1.5' : 'px-2')}>
            {NAV.map((item) => {
              const isActive = item.key === view
              const Icon = item.icon
              const badge = item.key in status ? status[item.key as keyof SidebarStatus] : null
              // 收起态没有文字位置放读数，但状态不能只靠颜色 —— 折进 aria-label
              const label = badge && collapsed ? `${item.label} · ${badge.text}` : item.label
              return (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`nav-${item.key}`}
                  data-badge={badge ? badge.tone : 'none'}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={collapsed ? label : undefined}
                  title={collapsed ? label : undefined}
                  onClick={() => setView(item.key)}
                  className={cn(
                    'relative flex h-8 cursor-pointer items-center gap-2.5 rounded-sm text-left text-[13px] transition-colors duration-150',
                    collapsed ? 'justify-center px-0' : 'px-2.5',
                    isActive ? 'bg-sel font-medium text-fg' : 'text-dim hover:bg-panel-2 hover:text-fg'
                  )}
                >
                  {isActive && (
                    <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-fg" />
                  )}
                  <span className="relative flex shrink-0 items-center justify-center">
                    <Icon size={14} aria-hidden />
                    {/* 收起态把读数退化成灯点：只有真信号才亮，正常时不打扰 */}
                    {collapsed && badge?.dot && (
                      <span
                        data-testid={`nav-dot-${item.key}`}
                        data-tone={badge.tone}
                        className={cn(
                          'absolute -right-1 -top-1 size-[6px] rounded-full',
                          BADGE_DOT[badge.tone]
                        )}
                      />
                    )}
                  </span>
                  {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                  {!collapsed && badge && (
                    <span
                      data-testid={`nav-badge-${item.key}`}
                      data-tone={badge.tone}
                      className={cn('num shrink-0 text-[10.5px]', BADGE_TEXT[badge.tone])}
                    >
                      {badge.text}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>

          {/* 左下角：主题三档拨档 + 收起/展开（版本号已移到标题栏「关于」弹窗） */}
          <div className={cn('mt-auto', collapsed ? 'px-1 pb-3' : 'px-3 pb-3')}>
            <div className="mb-2 h-px bg-line" />
            {collapsed ? (
              <div className="flex flex-col items-center gap-1.5">
                <ThemeSwitch value={theme} onChange={changeTheme} collapsed />
                <button
                  type="button"
                  data-testid="sidebar-toggle"
                  aria-label="展开侧栏"
                  aria-expanded={false}
                  title="展开侧栏"
                  onClick={toggleSidebar}
                  className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-faint transition-colors duration-150 hover:bg-panel-2 hover:text-fg"
                >
                  <ChevronsRight size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <ThemeSwitch value={theme} onChange={changeTheme} className="flex-1" />
                <button
                  type="button"
                  data-testid="sidebar-toggle"
                  aria-label="收起侧栏"
                  aria-expanded
                  title="收起侧栏"
                  onClick={toggleSidebar}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-faint transition-colors duration-150 hover:bg-panel-2 hover:text-fg"
                >
                  <ChevronsLeft size={14} />
                </button>
              </div>
            )}
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
            ) : view === 'startup' ? (
              <StartupView />
            ) : view === 'health' ? (
              <HealthView />
            ) : (
              <SettingsView />
            )}
          </section>
        </main>
      </div>

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
