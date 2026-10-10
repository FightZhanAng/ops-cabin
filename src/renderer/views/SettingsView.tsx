import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { toast } from 'sonner'
import type { AppInfo, Settings, ThemeMode } from '@shared/types'
import { Lamp } from '@/components/instrument/lamp'
import { Bay, Plate } from '@/components/instrument/plate'
import { DangerZone } from '@/components/settings/DangerZone'
import { ScanPlanEditor } from '@/components/settings/ScanPlanEditor'
import { ThemePicker } from '@/components/settings/ThemePicker'
import { UpdateSection } from '@/components/settings/UpdateSection'
import { WhitelistEditor } from '@/components/settings/WhitelistEditor'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/** 设置行：左标签 + 右控件，行间 1px 发丝线 */
function Row({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-h-[38px] items-center justify-between gap-4 border-b border-line px-3.5 py-1.5 last:border-b-0',
        className
      )}
    >
      <div className="min-w-0">
        <div className="text-[12.5px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-dim">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** 设置页：所有分组共用一块仪表板，改动即存（右上角有「已保存」闪现） */
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
      {/* 「已保存」闪现（所有字段共用一套反馈）：指示灯 + 文字，不停留 */}
      <div
        aria-hidden
        data-testid="saved-flash"
        className={cn(
          'pointer-events-none fixed right-6 top-16 z-20 flex items-center gap-1.5 rounded-sm border border-line-2 bg-panel px-2.5 py-1 text-[11.5px] transition-opacity duration-200',
          flash ? 'opacity-100' : 'opacity-0'
        )}
      >
        <Lamp state="ok" size={6} />
        <span>已保存</span>
      </div>

      <Plate className="mx-auto max-w-[680px]">
        <Bay
          eyebrow="GENERAL"
          title="通用"
          hint="主题会立即生效（渲染层跟随系统媒体查询，无闪帧）。"
          pad="none"
          bodyClassName="pt-1"
        >
          <Row label="主题">
            <ThemePicker
              value={settings.theme}
              onChange={(theme: ThemeMode) => void patch({ theme })}
            />
          </Row>
        </Bay>

        <Bay
          eyebrow="NOTIFY"
          title="通知"
          hint="关注的端口状态变化（被占用 / 释放 / 换主）时推系统通知。"
          pad="none"
          bodyClassName="pt-1"
        >
          <Row label="端口变化通知">
            <Switch
              checked={settings.notifyOnPortChange}
              onCheckedChange={(value) => void patch({ notifyOnPortChange: value })}
              data-testid="notify-switch"
            />
          </Row>
        </Bay>

        <Bay
          eyebrow="PROTECTION"
          title="白名单（保护目录）"
          hint="这里列出的目录在扫描与清理时都会被跳过。"
          pad="none"
        >
          <WhitelistEditor
            whitelist={settings.whitelist}
            onAdd={() => void addWhitelist()}
            onRemove={(path) => void removeWhitelist(path)}
          />
        </Bay>

        <Bay
          eyebrow="SCHEDULE"
          title="清理计划"
          hint="按计划自动扫描（只扫不删），完成后发通知。"
          pad="none"
        >
          <ScanPlanEditor plan={settings.scanPlan} onChange={(plan) => void patch({ scanPlan: plan })} />
        </Bay>

        <Bay
          eyebrow="UPDATE"
          title="更新"
          hint="检查 / 下载 / 安装三段分开，安装永远由你点；免安装版请到发布页手动更新。"
          pad="none"
        >
          <UpdateSection
            autoCheck={settings.autoCheckUpdate}
            onAutoCheckChange={(value) => void patch({ autoCheckUpdate: value })}
          />
        </Bay>

        <Bay eyebrow="ABOUT" title="关于" pad="none" bodyClassName="pt-1">
          <Row label="版本">
            <span className="num text-[11.5px]">{info ? `v${info.version}` : '—'}</span>
          </Row>
          <Row label="运行时">
            <span
              className="num max-w-[420px] truncate text-[11px] text-dim"
              title={
                info
                  ? `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`
                  : undefined
              }
            >
              {info
                ? `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`
                : '—'}
            </span>
          </Row>
          <Row label="数据目录" hint="设置、日志与扫描记录都放在这里。">
            <Button
              size="sm"
              variant="outline"
              data-testid="open-data-dir"
              onClick={() => void window.opsCabin.openDataDir()}
            >
              打开数据目录
            </Button>
          </Row>
        </Bay>

        <DangerZone onResetSettings={resetSettings} />
      </Plate>
    </div>
  )
}
