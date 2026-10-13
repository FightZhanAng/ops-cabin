import type { JSX } from 'react'
import {
  describeQuietHours,
  isWithinQuietHours,
  parseClock,
  SUSTAINED_REPEAT_MINUTES,
  type QuietHours
} from '@shared/notify'
import type { Settings } from '@shared/types'
import { SettingRow } from './SettingRow'
import { TimeField } from './TimeField'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

interface Props {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}

/*
 * 通知分组：四类信号各自的开关 + 持续异常重复提醒 + 安静时段。
 *
 * 上四行回答「哪些事值得打扰我」，下两行回答「什么时候别打扰我」——
 * 这两件事必须分开摆，混在一起（比如把安静时段塞进第四行）会让人以为
 * 它只对某一类信号生效。
 *
 * 每一行都写清楚**不通知时信号并没有消失**：四类信号在界面里各有各的落点
 * （端口事件流水账 / 服务面板与侧栏徽标 / 扫描记录 / 更新区块），
 * 关掉通知只是不再弹窗，不是把这个消息从世界上删掉。
 */
export function NotifySection({ settings, onPatch }: Props): JSX.Element {
  const quiet = settings.quietHours
  const quietNow = isWithinQuietHours(new Date(), quiet)
  const startMin = parseClock(quiet.start)
  const endMin = parseClock(quiet.end)
  // 起止相同 = 零长度区间（判据里视为不生效）—— 这属于「设了但没用」，
  // 必须显眼地说出来，否则用户会以为安静时段坏了
  const quietBroken = startMin === null || endMin === null || startMin === endMin

  const patchQuiet = (next: Partial<QuietHours>): void => {
    onPatch({ quietHours: { ...quiet, ...next } })
  }

  return (
    <div data-testid="notify-section">
      <SettingRow label="端口变化通知" hint="关注的端口被占用 / 释放 / 换主时推送">
        <Switch
          checked={settings.notifyOnPortChange}
          onCheckedChange={(value) => onPatch({ notifyOnPortChange: value })}
          data-testid="notify-switch"
        />
      </SettingRow>

      <SettingRow
        label="服务异常通知"
        hint="关注的服务挂起或恢复时推送（被禁用的服务停着不算异常）"
      >
        <Switch
          checked={settings.notifyOnServiceDown}
          onCheckedChange={(value) => onPatch({ notifyOnServiceDown: value })}
          data-testid="notify-service"
        />
      </SettingRow>

      <SettingRow label="计划扫描完成通知" hint="关掉只是不弹窗，扫描记录照常留在磁盘页">
        <Switch
          checked={settings.notifyOnScanDone}
          onCheckedChange={(value) => onPatch({ notifyOnScanDone: value })}
          data-testid="notify-scan"
        />
      </SettingRow>

      <SettingRow label="新版本通知" hint="自动检查发现新版本时推送；设置页侧栏也会亮「有新版本」">
        <Switch
          checked={settings.notifyOnUpdate}
          onCheckedChange={(value) => onPatch({ notifyOnUpdate: value })}
          data-testid="notify-update"
        />
      </SettingRow>

      <SettingRow
        label="异常持续时重复提醒"
        hint={`服务一直没恢复时每 ${SUSTAINED_REPEAT_MINUTES} 分钟再提醒一次；关掉就只在刚挂时提醒一次`}
      >
        <Switch
          checked={settings.notifySustained}
          onCheckedChange={(value) => onPatch({ notifySustained: value })}
          data-testid="notify-sustained"
        />
      </SettingRow>

      <SettingRow
        label="安静时段"
        hint="区间内不推通知 —— 信号本身照常产生，在页面里看得到"
      >
        <Switch
          checked={quiet.enabled}
          onCheckedChange={(value) => patchQuiet({ enabled: value })}
          data-testid="quiet-switch"
        />
      </SettingRow>

      {quiet.enabled && (
        <div className="flex min-h-[38px] items-center justify-between gap-4 border-t border-line px-3.5 py-1.5">
          <div className="min-w-0">
            <div className="text-[12.5px]">静音区间</div>
            <div
              className={cn(
                'mt-0.5 text-[11px] leading-relaxed',
                quietBroken ? 'text-warn' : 'text-dim'
              )}
              data-testid="quiet-note"
            >
              {quietBroken
                ? '起止时刻相同，不会静音'
                : `${describeQuietHours(quiet)}${quietNow ? ' · 此刻正在静音' : ''}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <TimeField
              id="quiet-start"
              testId="quiet-start"
              value={quiet.start}
              label="安静时段开始"
              placeholder="22:00"
              onCommit={(value) => patchQuiet({ start: value })}
            />
            <span className="text-[12px] text-faint">–</span>
            <TimeField
              id="quiet-end"
              testId="quiet-end"
              value={quiet.end}
              label="安静时段结束"
              placeholder="08:00"
              onCommit={(value) => patchQuiet({ end: value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}
