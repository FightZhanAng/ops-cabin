import { useEffect, useMemo, useState } from 'react'
import type { VolumeInfo } from '@shared/disk'
import { formatBytes } from '@shared/format'
import type { PortChange, PortsSnapshot, WatchItem } from '@shared/ports'
import { serviceDown, type ServiceStatusReport } from '@shared/services'
import type { StartupReport } from '@shared/startup'
import type { UpdateState } from '@shared/update'
import { freeTone } from '@/components/instrument/seg-bar'

/*
 * 侧栏常驻状态：让「有没有事」在收起状态下也看得见。
 *
 * 这一层存在的意义是**不开页面也知道**。批次 1 把总览补成了「打开能看全」，
 * 但只要不开那个页面就一无所知 —— 这里补的就是那个缺口。
 *
 * 数据来源刻意分三档，代价从低到高：
 *
 *   1. 端口快照与变化 —— **纯推送，零新增采集**。端口监控在主进程本来就有
 *      懒轮询（有关注项时无人订阅也每 5 秒一拍），这里只是把已经在流的
 *      `ports:snapshot` 也听一份。刻意**不调用 subscribePorts()** ——
 *      那会把采样提到 2 秒常驻，等于为了几个徽标让 netstat 永远跑着。
 *   2. 分区余量 —— 走 fs.statfs（毫秒级，不起进程），一分钟一次可以忽略。
 *   3. 服务状态与自启项 —— 需要一次 PowerShell。服务一分钟一次（状态会变，
 *      「挂了要早知道」是它的全部价值）；自启项走主进程的 TTL 缓存（**30 秒**，
 *      见 src/main/index.ts 的 STARTUP_TTL），侧栏自己的刷新间隔是 60 秒，
 *      所以每轮几乎都会真的起一次进程 —— 这是刻意的：自启项页与侧栏要保证
 *      「刚在任务管理器里禁用过」能在一分钟内反映出来。
 *      （早前这里写「5 分钟 TTL」，与代码不符，会让人以为可以放心调快刷新。）
 *
 * 读数口径与页面保持一致：磁盘用 freeTone() 的 5/10GB 阈值，不用百分比 ——
 * 侧栏和磁盘页给出不同的判断会比不给更糟。
 */

/** 侧栏读数刷新间隔（不含推送型的端口数据） */
const REFRESH_MS = 60_000

/**
 * 「新情况」的时间窗。
 *
 * 信号条列的是「最近 5 条变化」，不区分多久以前 —— 那是流水账的语义。
 * 徽标要回答的是「现在有没有事」，所以必须带时间窗，否则历史上的任何变化
 * 都会让徽标永远挂着数字，永远不落。
 */
const ALERT_WINDOW_MS = 5 * 60_000

export interface NavBadge {
  tone: 'ok' | 'warn' | 'danger' | 'idle'
  text: string
  /** 收起态是否亮灯点：只有真信号（warn / danger）才亮，正常时不打扰 */
  dot: boolean
}

export interface SidebarStatus {
  overview: NavBadge | null
  disk: NavBadge | null
  ports: NavBadge | null
  startup: NavBadge | null
  settings: NavBadge | null
}

/*
 * 「体检」刻意没有徽标。
 *
 * 它的数据要起四段 PowerShell（本机 3.8 秒，是这里最贵的一份），而侧栏每分钟
 * 刷一次 —— 挂上去等于每分钟白跑一次重活。而且它管的是「这台机器整体还好吗」，
 * 是按天变的东西：磁盘健康、设备错误码、开机时刻都不会在你刷侧栏的工夫里悄悄变。
 * 用户真想知道就点进那一页，主进程侧还有 60 秒 TTL 兜住来回切。
 *
 * 这不是「忘了加」，是有意的取舍 —— 别在下一批顺手补上。
 *
 * 设置页有徽标，但只承载**一件事**：有新版本（可下载 / 已下载待安装）。
 * 它之所以该存在，是因为通知可能被安静时段挡下 —— 挡下之后总得有个地方
 * 还看得见「有新版本」，否则那条消息就真的没了。除此之外设置页不该亮灯。
 */

const EMPTY: SidebarStatus = {
  overview: null,
  disk: null,
  ports: null,
  startup: null,
  settings: null
}

export function useSidebarStatus(view: string): SidebarStatus {
  const [volumes, setVolumes] = useState<VolumeInfo[]>([])
  const [watchlist, setWatchlist] = useState<WatchItem[]>([])
  const [snapshot, setSnapshot] = useState<PortsSnapshot | null>(null)
  const [changes, setChanges] = useState<PortChange[]>([])
  const [services, setServices] = useState<ServiceStatusReport | null>(null)
  const [startup, setStartup] = useState<StartupReport | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)

  // 推送型：只监听，不订阅（订阅会把端口采样提到 2 秒常驻）
  useEffect(() => {
    const offSnapshot = window.opsCabin.onPortsSnapshot(setSnapshot)
    const offChanges = window.opsCabin.onPortsChanges((incoming) => {
      setChanges((prev) => [...incoming].reverse().concat(prev).slice(0, 200))
    })
    // 更新状态也是推送型：检查是主进程自己按天做的，渲染层只要跟着显示
    const offUpdate = window.opsCabin.onUpdate(setUpdate)
    void window.opsCabin.getUpdate().then(setUpdate)
    return () => {
      offSnapshot()
      offChanges()
      offUpdate()
    }
  }, [])

  // 读取型：挂载、切页、窗口重新获得焦点、每分钟 —— 四个时机各覆盖一类场景
  useEffect(() => {
    let alive = true
    /*
     * 每个拉取都要 catch。
     *
     * 侧栏是常驻组件，这五个通道里任何一个 reject（主进程忙、IPC 抛错、采集
     * 超时）都会变成渲染层的 unhandled rejection —— 控制台一片红，而界面上
     * 什么都不说。侧栏是「有没有事」的读数面，读不到时该保留上一次的值并安静
     * 等下一样，而不是把整个页面拖进可疑状态。
     */
    const pull = (): void => {
      const guard = <T,>(p: Promise<T>, apply: (value: T) => void): void => {
        void p
          .then((value) => {
            if (alive) apply(value)
          })
          .catch(() => {
            /* 读不到就保持现状：侧栏不是权威数据源，下一次 pull 会再试 */
          })
      }
      guard(window.opsCabin.listVolumes(), setVolumes)
      guard(window.opsCabin.getWatchlist(), setWatchlist)
      guard(window.opsCabin.listPortEvents(), setChanges)
      guard(window.opsCabin.listServices(), setServices)
      guard(window.opsCabin.listStartup(), setStartup)
    }
    pull()
    const timer = setInterval(pull, REFRESH_MS)
    window.addEventListener('focus', pull)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', pull)
    }
  }, [view])

  return useMemo<SidebarStatus>(() => {
    if (
      volumes.length === 0 &&
      watchlist.length === 0 &&
      services === null &&
      !startup &&
      update === null
    ) {
      return EMPTY
    }

    // 磁盘：按余量最小的那块盘报（它才是会先出事的那块）
    let tightest: VolumeInfo | null = null
    for (const volume of volumes) {
      if (tightest === null || volume.free < tightest.free) tightest = volume
    }
    // 余量充足映射成中性色而不是绿色：侧栏天天挂着一片绿等于没有信号
    const diskTone: NavBadge['tone'] = tightest
      ? freeTone(tightest.free) === 'danger'
        ? 'danger'
        : freeTone(tightest.free) === 'warn'
          ? 'warn'
          : 'idle'
      : 'idle'

    // 总览：磁盘将满的盘数 + 窗口内的端口变化数（与信号条的构成同源，但带时间窗）
    const now = Date.now()
    const lowDisks = volumes.filter((volume) => volume.free < 10 * 1024 ** 3).length
    const recentChanges = changes.filter((change) => now - change.at < ALERT_WINDOW_MS).length
    const alerts = lowDisks + recentChanges

    // 端口：关注清单里有几个正在被监听
    const entries = snapshot?.entries ?? []
    const occupied = watchlist.filter((item) => entries.some((e) => e.port === item.port)).length

    // 服务「不在跑」：判据在 shared/services.ts 里只有一份（serviceDown），
    // 与端口页服务面板、后台盯梢的通知同源 —— 三处读数不一致比只给一处更糟。
    const serviceItems = services?.items ?? []
    const serviceDownCount = serviceItems.filter(serviceDown).length

    return {
      overview: alerts > 0 ? { tone: 'warn', text: `${alerts} 条`, dot: true } : null,
      disk: tightest
        ? {
            tone: diskTone,
            text: `剩 ${formatBytes(tightest.free)}`,
            dot: diskTone === 'warn' || diskTone === 'danger'
          }
        : null,
      ports:
        serviceDownCount > 0
          ? { tone: 'warn', text: `服务 ${serviceDownCount} 不在跑`, dot: true }
          : // 读数失败要单独说一句。此时 items 是空的，serviceDownCount 必然是 0 ——
            // 不说的话这里会落到下面的「2/3」中性读数，把「读不到」显示成一切正常。
            services?.degraded === true
            ? { tone: 'warn', text: '服务状态读不到', dot: true }
            : watchlist.length > 0
              ? { tone: 'idle', text: `${occupied}/${watchlist.length}`, dot: false }
              : null,
      startup:
        startup && startup.invalid > 0
          ? { tone: 'warn', text: `${startup.invalid} 项失效`, dot: true }
          : null,
      // 有新版本才亮灯：可下载与「已下载待安装」都算 —— 后者其实更该催，
      // 因为它只需要重启就生效，而用户往往已经忘了自己下载过。
      settings:
        update?.status === 'available'
          ? { tone: 'warn', text: '有新版本', dot: true }
          : update?.status === 'downloaded'
            ? { tone: 'warn', text: '待安装', dot: true }
            : null
    }
  }, [volumes, watchlist, snapshot, changes, services, startup, update])
}
