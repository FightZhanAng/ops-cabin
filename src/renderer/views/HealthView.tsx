import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatBytes, formatClock, formatDuration, formatStamp } from '@shared/format'
import {
  DEVICE_LEVEL_TEXT,
  REBOOT_LEVEL_TEXT,
  REBOOT_SOURCE_LABEL,
  REBOOT_SOURCE_NOTE,
  deviceLevel,
  diskBusText,
  diskHealthText,
  diskLooksHealthy,
  diskMediaText,
  diskOperationalText,
  type CrashEvent,
  type DiskHealth,
  type HealthLog,
  type HealthReport,
  type ProblemDevice,
  type RebootCheck
} from '@shared/health'
import { cn } from 'cn'
import { Bay, Plate } from '@/components/instrument/plate'
import { Lamp } from '@/components/instrument/lamp'
import { StatGrid } from '@/components/instrument/stat-grid'
import { Button } from '@/components/ui/button'

/*
 * 系统体检（只读）。
 *
 * 这一页回答的是一个本来散在四五个系统工具里的问题：**这台机器整体还好吗**。
 * 故障盘、待重启、报错设备、事件日志、上次是不是没好好关机 —— 原本要分别去
 * 「优化驱动器」「Windows 更新」「设备管理器」「事件查看器」各看一处。
 *
 * ## 这一页的叙事顺序不是随手排的
 *
 * 先给结论（四个读数），再按「有没有事要办」从重到轻铺开：待重启 → 磁盘 →
 * 设备 → 日志 → 意外关机。用户扫一眼结论就知道要不要往下看。
 *
 * ## 三条口径，每条都在界面上说出来了
 *
 *   1. **「已禁用」不算故障。** 这是同一套纪律第五次出现（服务 → 自启项 →
 *      计划任务 → 设备）。界面上单独一档，并且写明为什么。
 *   2. **待处理文件队列不是「要求重启」。** 它是应用自己排的「下次开机顺手删」，
 *      印成「要求重启」会让用户白重启一次。所以它单独一行、标「不必为此重启」。
 *   3. **拿不到就说拿不到。** SMART 磨损度与温度这一版没取，界面上直说，
 *      不拿「未知」冒充一个读数 —— 磁盘的 `HealthStatus` 只有 0（健康）
 *      才算通过，null 与 5（未知）都不算。
 */

/** 磁盘健康档 → 灯。只有 0 是 ok；「读不到」与「未知」都走 idle 而不是 ok */
function diskLamp(disk: DiskHealth): 'ok' | 'warn' | 'idle' {
  if (diskLooksHealthy(disk)) return 'ok'
  if (disk.healthRaw === null) return 'idle'
  if (disk.healthRaw === 5) return 'idle'
  return 'warn'
}

function diskHealthTone(disk: DiskHealth): string {
  if (diskLooksHealthy(disk)) return 'text-faint'
  const text = diskHealthText(disk.healthRaw)
  return text === null || text === '未知' ? 'text-faint' : 'text-warn'
}

function RebootRow({ item }: { item: RebootCheck }): JSX.Element {
  const required = item.level === 'required'
  const tooltip =
    item.paths.length > 0
      ? `${REBOOT_SOURCE_NOTE[item.source]}\n\n排队的文件：\n${item.paths.join('\n')}`
      : REBOOT_SOURCE_NOTE[item.source]
  return (
    <div
      data-testid="reboot-row"
      data-source={item.source}
      data-level={item.level}
      className="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0"
    >
      <span className="flex w-[26px] shrink-0 items-center justify-center pt-[3px]">
        {item.level === 'clear' ? null : (
          <Lamp
            state={required ? 'warn' : 'idle'}
            size={7}
            label={REBOOT_LEVEL_TEXT[item.level]}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12.5px]">{REBOOT_SOURCE_LABEL[item.source]}</span>
          <span
            className={cn('shrink-0 text-[10.5px]', required ? 'text-warn' : 'text-faint')}
            title={tooltip}
          >
            {REBOOT_LEVEL_TEXT[item.level]}
          </span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-faint" title={tooltip}>
          {item.detail ?? REBOOT_SOURCE_NOTE[item.source]}
        </span>
      </span>
    </div>
  )
}

function DiskRow({ disk }: { disk: DiskHealth }): JSX.Element {
  const health = diskHealthText(disk.healthRaw)
  const facts = [
    diskMediaText(disk.mediaRaw),
    diskBusText(disk.busRaw),
    disk.sizeBytes !== null ? formatBytes(disk.sizeBytes) : null
  ].filter((value): value is string => value !== null)
  const ops = diskOperationalText(disk.operationalRaw)
  return (
    <div
      data-testid="disk-row"
      data-name={disk.name}
      data-system={disk.system ? '1' : '0'}
      data-health={disk.healthRaw === null ? 'none' : `${disk.healthRaw}`}
      className="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0"
    >
      <span className="flex w-[26px] shrink-0 items-center justify-center pt-[3px]">
        <Lamp state={diskLamp(disk)} size={7} label={`健康档 ${health ?? '未知'}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12.5px]">{disk.name}</span>
          {disk.system && (
            // 走 dim 而不是 faint：它承载的是「哪块是系统盘」这个真信息，
            // faint 在深色主题下几乎读不出来
            <span className="eyebrow shrink-0 text-dim" title="系统盘">
              系统盘
            </span>
          )}
        </span>
        {/* 转速/介质/总线是数据，走 .num 等宽 */}
        <span className="num mt-0.5 block min-w-0 truncate text-[11px] text-faint">
          {facts.length > 0 ? facts.join(' · ') : '介质与总线读不到'}
          {ops !== null ? ` · ${ops}` : ''}
        </span>
      </span>
      <span className={cn('shrink-0 text-[11px]', diskHealthTone(disk))}>
        {/*
         * 读不到健康档时印「读不到」而不是「未知」：`HealthStatus` 的 5 官方就叫
         * Unknown，两者含义不同 —— 一个是系统说不清，一个是我们没读到。
         */}
        {disk.healthRaw === null ? '读不到' : (health ?? '—')}
      </span>
    </div>
  )
}

function DeviceRow({ device }: { device: ProblemDevice }): JSX.Element {
  const level = deviceLevel(device.code)
  return (
    <div
      data-testid="device-row"
      data-level={level}
      data-code={`${device.code}`}
      data-name={device.name}
      className="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0"
    >
      <span className="flex w-[26px] shrink-0 items-center justify-center pt-[3px]">
        <Lamp
          state={level === 'disabled' ? 'idle' : 'warn'}
          size={7}
          label={DEVICE_LEVEL_TEXT[level]}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="min-w-0 truncate text-[12.5px]">{device.name}</span>
        <span className="mt-0.5 block min-w-0 truncate text-[11px] text-faint">
          {device.pnpClass}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span
          className={cn('block text-[11px]', level === 'disabled' ? 'text-dim' : 'text-warn')}
        >
          {DEVICE_LEVEL_TEXT[level]}
        </span>
        {/* WMI 的 Status 对已禁用设备也报 "Error"，所以只留在悬停里，不摆到面上误导 */}
        <span className="num block text-[10.5px] text-faint" title={`设备状态：${device.status}`}>
          代码 {device.code}
        </span>
      </span>
    </div>
  )
}

function LogBlock({ log }: { log: HealthLog }): JSX.Element {
  return (
    <div data-testid="log-block" data-log={log.logName} data-total={log.total} data-window={log.windowDays} data-providers={log.providers.length} data-truncated={log.truncated ? '1' : '0'}>
      <div className="flex items-center gap-2 border-y border-line bg-panel-2 px-3.5 py-1.5 first:border-t-0">
        <span className="eyebrow truncate text-dim">{log.logName}</span>
        <span className="num ml-auto shrink-0 text-[10.5px] text-faint">
          {/* 窗口必须印出来，否则「16 条」没有意义 */}
          近 {log.windowDays} 天 · {log.truncated ? '≥' : ''}
          {log.total} 条
        </span>
      </div>
      {log.providers.length === 0 ? (
        <div className="px-3.5 py-2 text-[11px] text-dim">
          这个窗口里没有错误记录。
        </div>
      ) : (
        log.providers.map((provider) => (
          <div
            key={provider.name}
            data-testid="log-provider"
            data-name={provider.name}
            data-count={provider.count}
            className="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-[12px]">{provider.name}</span>
                {provider.lastId !== null && (
                  <span className="num shrink-0 text-[10.5px] text-faint">
                    id {provider.lastId}
                  </span>
                )}
              </span>
              <span
                className="num mt-0.5 block min-w-0 truncate text-[11px] text-faint"
                title={provider.sample ?? undefined}
              >
                {provider.sample ?? '（这条没有可读的消息正文）'}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="num block text-[12px]">{provider.count} 次</span>
              <span className="num block whitespace-nowrap text-[10.5px] text-faint">
                {provider.lastAt !== null ? formatStamp(provider.lastAt) : '—'}
              </span>
            </span>
          </div>
        ))
      )}
    </div>
  )
}

function CrashRow({ crash }: { crash: CrashEvent }): JSX.Element {
  return (
    <div
      data-testid="crash-row"
      data-id={`${crash.id}`}
      data-source={crash.source}
      className="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0"
    >
      <span className="flex w-[26px] shrink-0 items-center justify-center pt-[3px]">
        <Lamp state="warn" size={7} label="意外关机" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="num shrink-0 text-[12px]">{formatStamp(crash.at)}</span>
          <span className="min-w-0 truncate text-[10.5px] text-faint">
            {crash.source} · id {crash.id}
          </span>
        </span>
        {/* 用系统自己的话，不自己编解释 */}
        <span className="mt-0.5 block text-[11px] leading-relaxed text-faint" title={crash.message}>
          {crash.message}
        </span>
      </span>
    </div>
  )
}

export function HealthView(): JSX.Element {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback((force: boolean): void => {
    setLoading(true)
    window.opsCabin
      .readHealth(force)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false))
  }, [])

  // 这一页要起四段 PowerShell（本机 3.8 秒），只在真的进到这一页时才采集。
  // 主进程侧还有 60 秒 TTL 兜住来回切。
  useEffect(() => {
    load(false)
  }, [load])

  const disks = report?.disks ?? []
  const devices = report?.devices ?? []
  const logs = report?.logs ?? []
  const crashes = report?.crashes ?? []
  const badDisks = disks.filter((disk) => !diskLooksHealthy(disk)).length
  const problems = devices.filter((device) => deviceLevel(device.code) === 'problem')
  const disabled = devices.filter((device) => deviceLevel(device.code) === 'disabled')
  const pending = loading && !report
  const rebootRequired = report?.rebootRequired ?? 0

  return (
    <div
      className="h-full min-h-0 overflow-auto p-4"
      data-testid="health-view"
      data-state={pending ? 'loading' : report === null ? 'error' : 'ready'}
    >
      <div className="flex flex-col gap-3">
        <Plate>
          <Bay
            eyebrow="SYSTEM · HEALTH"
            title="体检结论"
            aside={
              <Button
                variant="outline"
                size="xs"
                onClick={() => load(true)}
                disabled={loading}
                data-testid="health-refresh"
              >
                <RefreshCw />
                {loading ? '读取中…' : '重新体检'}
              </Button>
            }
            hint={
              report?.error
                ? `部分读数没读到：${report.error}`
                : '只读体检 —— 不修、不改、不动任何系统设置。读数取自本机 WMI、事件日志与注册表。'
            }
          >
            <StatGrid
              data-testid="health-stats"
              data-uptime={report?.uptimeMs ?? ''}
              data-reboot={rebootRequired}
              data-device-problems={problems.length}
              data-device-disabled={disabled.length}
              data-disks={disks.length}
              data-bad-disks={badDisks}
              data-logs={logs.length}
              data-crashes={crashes.length}
              cells={[
                {
                  label: '开机时长',
                  value:
                    report?.uptimeMs != null ? formatDuration(report.uptimeMs) : pending ? '—' : '读不到',
                },
                {
                  label: '待重启',
                  value: rebootRequired > 0 ? `${rebootRequired} 处` : pending ? '—' : '无',
                  danger: rebootRequired > 0
                },
                {
                  label: '问题设备',
                  value: problems.length > 0 ? `${problems.length} 台` : pending ? '—' : '无',
                  danger: problems.length > 0
                },
                {
                  label: '磁盘',
                  value:
                    disks.length === 0
                      ? pending
                        ? '—'
                        : '读不到'
                      : badDisks > 0
                        ? `${badDisks} 块需留意`
                        : '健康',
                  danger: badDisks > 0
                }
              ]}
            />
            <div className="num mt-2 flex items-baseline gap-2 text-[10.5px] text-faint">
              <span>
                {report?.bootedAt != null
                  ? `开机于 ${formatStamp(report.bootedAt)} · `
                  : ''}
                读于 {report ? formatClock(report.at) : '—'}
                {report && report.durationMs > 0 ? ` · ${report.durationMs}ms` : ''}
              </span>
            </div>
          </Bay>

          <Bay
            eyebrow="REBOOT"
            title="待重启"
            pad="none"
            hint="前两处是 Windows 自己写的「必须重启」标记；第三处只是文件队列，不是重启要求。"
            data-testid="health-reboot"
          >
            {(report?.reboot ?? []).length === 0 ? (
              <div className="px-3.5 pb-4 pt-1 text-[11px] leading-relaxed text-dim">
                {pending ? '读取中…' : '没读到重启标记 —— 上面那条失败原因说明了是为什么。'}
              </div>
            ) : (
              report?.reboot.map((item) => <RebootRow key={item.source} item={item} />)
            )}
          </Bay>
        </Plate>

        {/* 两列的门槛是 lg(1024px) 而不是 xl(1280px)：默认窗口宽 1180px，
            写 xl 的话这两列在默认尺寸下**永远不生效**，四格会一路竖着排下去。 */}
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <Plate>
            <Bay
              eyebrow="STORAGE"
              title="磁盘健康"
              pad="none"
              hint="只给健康档：SMART 磨损度与温度要另走厂商接口，这一版没取。读数里 5（未知）与「读不到」都不算通过。"
              data-testid="health-disks"
            >
              {disks.length === 0 ? (
                <div className="px-3.5 pb-4 pt-1 text-[11px] leading-relaxed text-dim">
                  {pending ? '读取中…' : '一块盘都没读到 —— 物理磁盘查询失败了，不是这台机器没硬盘。'}
                </div>
              ) : (
                disks.map((disk) => <DiskRow key={disk.name} disk={disk} />)
              )}
            </Bay>

            <Bay
              eyebrow="DEVICE"
              title="报错设备"
              pad="none"
              hint="设备管理器里有错误码的设备。「已禁用」是你自己在设备管理器里关掉的 —— Windows 自带的 pnputil 也不把它算作问题设备。"
              data-testid="health-devices"
            >
              {devices.length === 0 ? (
                <div className="px-3.5 pb-4 pt-1 text-[11px] leading-relaxed text-dim">
                  {pending ? '读取中…' : '没有带错误码的设备。'}
                </div>
              ) : (
                devices.map((device) => <DeviceRow key={`${device.name}-${device.code}`} device={device} />)
              )}
            </Bay>
          </Plate>

          <Plate>
            <Bay
              eyebrow="EVENT LOG"
              title="事件日志摘要"
              pad="none"
              hint="只取严重与错误两档，按来源聚合 —— 同一个来源反复报，比「到处都在报」更容易定位。"
              data-testid="health-logs"
            >
              {logs.length === 0 ? (
                <div className="px-3.5 pb-4 pt-1 text-[11px] leading-relaxed text-dim">
                  {pending ? '读取中…' : '两条日志都没读到 —— 上面那条失败原因说明了是为什么。'}
                </div>
              ) : (
                logs.map((log) => <LogBlock key={log.logName} log={log} />)
              )}
            </Bay>

            <Bay
              eyebrow="UNEXPECTED SHUTDOWN"
              title="意外关机"
              pad="none"
              hint={`近 ${report?.crashWindowDays ?? 30} 天里「没干净关机」的记录（断电 / 蓝屏 / 强制断电）—— 用系统自己的原话，不另作解释。`}
              data-testid="health-crashes"
            >
              {crashes.length === 0 ? (
                <div className="px-3.5 pb-4 pt-1 text-[11px] leading-relaxed text-dim">
                  {pending
                    ? '读取中…'
                    : `近 ${report?.crashWindowDays ?? 30} 天没有意外关机 —— 上次都是好好关的。`}
                </div>
              ) : (
                crashes.map((crash) => <CrashRow key={`${crash.source}-${crash.id}-${crash.at}`} crash={crash} />)
              )}
            </Bay>
          </Plate>
        </div>
      </div>
    </div>
  )
}
