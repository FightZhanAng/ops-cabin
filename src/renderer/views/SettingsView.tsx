import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { toast } from 'sonner'
import type { AppInfo, Settings, ThemeMode } from '@shared/types'
import { DangerZone } from '@/components/settings/DangerZone'
import { ScanPlanEditor } from '@/components/settings/ScanPlanEditor'
import { ThemePicker } from '@/components/settings/ThemePicker'
import { UpdateSection } from '@/components/settings/UpdateSection'
import { WhitelistEditor } from '@/components/settings/WhitelistEditor'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

function Section({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="rounded-[10px] border border-line bg-panel p-4">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {desc && <p className="mt-1 text-[11px] leading-relaxed text-dim">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-[12px]">
      <span>{label}</span>
      {children}
    </div>
  )
}

/** 设置页：分组表单，改动即存（右上角有「已保存」闪现） */
export function SettingsView(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [flash, setFlash] = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void window.opsCabin.getSettings().then((s) => {
      if (alive) setSettings(s)
    })
    void window.opsCabin.getAppInfo().then((i) => {
      if (alive) setInfo(i)
    })
    const off = window.opsCabin.onSettings((s) => setSettings(s))
    return () => {
      alive = false
      off()
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [])

  const patch = useCallback(async (p: Partial<Settings>): Promise<void> => {
    const applied = await window.opsCabin.updateSettings(p)
    if (applied) setSettings(applied)
    setFlash(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(false), 1500)
  }, [])

  const addWhitelist = useCallback(async (): Promise<void> => {
    const picked = await window.opsCabin.pickDirectory()
    if (!picked) return
    if (settings?.whitelist.includes(picked)) {
      toast('该目录已在白名单里')
      return
    }
    await patch({ whitelist: [...(settings?.whitelist ?? []), picked] })
    toast.success('已加入白名单')
  }, [settings, patch])

  const removeWhitelist = useCallback(
    async (path: string): Promise<void> => {
      await patch({ whitelist: (settings?.whitelist ?? []).filter((p) => p !== path) })
    },
    [settings, patch]
  )

  const resetSettings = useCallback(async (): Promise<void> => {
    const applied = await window.opsCabin.resetSettings()
    if (applied) setSettings(applied)
  }, [])

  if (!settings) {
    return <div className="p-6 text-[12px] text-dim">正在读取设置…</div>
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="settings-view">
      {/* 「已保存」闪现（所有字段共用一套反馈） */}
      <div
        aria-hidden
        data-testid="saved-flash"
        className={cn(
          'pointer-events-none fixed right-6 top-16 z-20 rounded-md border border-signal/40 bg-panel-2 px-2.5 py-1 text-[11px] text-signal transition-opacity duration-200',
          flash ? 'opacity-100' : 'opacity-0'
        )}
      >
        已保存
      </div>

      <div className="mx-auto max-w-2xl space-y-4">
        <Section title="通用" desc="主题会立即生效（渲染层跟随系统媒体查询，无闪帧）。">
          <Row label="主题">
            <ThemePicker value={settings.theme} onChange={(theme: ThemeMode) => void patch({ theme })} />
          </Row>
        </Section>

        <Section title="通知" desc="关注的端口状态变化（被占用 / 释放 / 换主）时推系统通知。">
          <Row label="端口变化通知">
            <Switch
              checked={settings.notifyOnPortChange}
              onCheckedChange={(value) => void patch({ notifyOnPortChange: value })}
              data-testid="notify-switch"
              className="cursor-pointer"
            />
          </Row>
        </Section>

        <Section title="白名单（保护目录）" desc="这里列出的目录在扫描与清理时都会被跳过。">
          <WhitelistEditor
            whitelist={settings.whitelist}
            onAdd={() => void addWhitelist()}
            onRemove={(path) => void removeWhitelist(path)}
          />
        </Section>

        <Section title="清理计划" desc="按计划自动扫描（只扫不删），完成后发通知。">
          <ScanPlanEditor plan={settings.scanPlan} onChange={(plan) => void patch({ scanPlan: plan })} />
        </Section>

        <Section
          title="更新"
          desc="检查 / 下载 / 安装三段分开，安装永远由你点；免安装版请到发布页手动更新。"
        >
          <UpdateSection
            autoCheck={settings.autoCheckUpdate}
            onAutoCheckChange={(value) => void patch({ autoCheckUpdate: value })}
          />
        </Section>

        <Section title="关于">
          <div className="space-y-1.5">
            <Row label="版本">
              <span className="font-mono text-[11px]">{info?.version ?? '—'}</span>
            </Row>
            <Row label="运行时">
              <span className="font-mono text-[10.5px] text-dim">
                {info ? `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}` : '—'}
              </span>
            </Row>
            <div className="pt-1.5">
              <Button
                size="sm"
                variant="outline"
                data-testid="open-data-dir"
                onClick={() => void window.opsCabin.openDataDir()}
              >
                打开数据目录
              </Button>
            </div>
          </div>
        </Section>

        <DangerZone onResetSettings={resetSettings} />
      </div>
    </div>
  )
}
