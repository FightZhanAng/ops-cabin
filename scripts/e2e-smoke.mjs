// M8 应用内冒烟自检的对账脚本（跑两轮：浅色 / 深色）。
//
// 应用以 OPS_CABIN_SMOKE=1 OPS_CABIN_SMOKE_EXIT=1 启动，主进程驱动界面走一圈
// （总览 → 磁盘扫描 → 端口 → 启动项/计划任务 → 体检 → 设置），把 DOM 事实与截图写进
// %TEMP%/ops-cabin-smoke；本脚本等待其退出后逐项断言，并把两轮结果分别留档。
//
// 用法：node scripts/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

let failures = 0
/** 逐项结果：控制台的编码转换会把标记搞花，JSON 留档才是可靠的诊断依据 */
const results = []

/**
 * 种子清理历史（`ago` = 距今毫秒）：4 条、最远 9 天前，全部落在
 * 14 天柱状图 / 30 天折线窗口内。断言期望值从这里推导，避免两处各写一遍。
 */
const SEED = [
  { ago: 9 * 864e5, mode: 'recycle', freedBytes: 3 * 1024 ** 3, itemCount: 12 },
  { ago: 5 * 864e5, mode: 'recycle', freedBytes: 1024 ** 3, itemCount: 5 },
  { ago: 2 * 864e5, mode: 'permanent', freedBytes: 512 * 1024 ** 2, itemCount: 3 },
  { ago: 3600e3, mode: 'recycle', freedBytes: 256 * 1024 ** 2, itemCount: 2 }
]
const SEED_TOTAL = SEED.reduce((sum, item) => sum + item.freedBytes, 0)

/**
 * 趋势种子：12 个点落在 24 小时窗内，另 7 个落在 24 小时外、7 天窗内。
 *
 * 「窗内条数」不能写死 —— TrendStore 启动时会自己补一个点，把 13/20 写成期望值
 * 等于把实现细节焊进断言。断言改成「7 天窗比 24 小时窗恰好多 7 个点」：
 * 两个窗都会被同一个启动补点影响，差值只由种子决定。
 */
const TREND_24H_HOURLY = 12
const TREND_OLD_COUNT = 7
/**
 * 24 小时窗内 12 个点的形状（最旧在前）：要有起伏、有平台，而不是一条直线斜坡 ——
 * 截图是给人看趋势图长什么样的，斜线看不出折线本身对不对。
 * 峰值固定 88.5（断言用「≥」，因为应用启动时自己补的那个点可能更高）。
 */
const TREND_SHAPE = [
  { cpu: 88.5, mem: 58.2 },
  { cpu: 74.1, mem: 59.6 },
  { cpu: 52.3, mem: 60.1 },
  { cpu: 31.7, mem: 58.8 },
  { cpu: 24.9, mem: 57.4 },
  { cpu: 46.2, mem: 61.3 },
  { cpu: 63.8, mem: 64.9 },
  { cpu: 41.5, mem: 63.2 },
  { cpu: 28.4, mem: 60.7 },
  { cpu: 35.9, mem: 59.1 },
  { cpu: 57.6, mem: 62.8 },
  { cpu: 22.1, mem: 60.4 }
]
/** 种子里的 CPU 峰值；断言用「≥」而不是「=」*/
const TREND_CPU_PEAK = 88.5

/**
 * 服务关注清单种子（写进隔离 userData 的 service-watch.json）。
 *
 * 挑名的唯一原则是「结果在任何 Windows 上都确定」：
 *   - Winmgmt：WMI 提供程序本身。查询能返回结果就说明它在跑 —— 自证式确定。
 *   - EventLog：Windows 事件日志，受保护服务，停不掉。
 *   - 第三个是**故意不存在的服务名**，用来确定性地覆盖「关注项成了空壳」（missing）
 *     这一档 —— 真实环境里要卸载掉一个软件才会碰到，没法稳定复现。
 * 刻意不种「已禁用」的服务：哪台机器上有、当前什么状态全看运气，
 * 种进去只会得到一个随机器飘的断言。
 */
const SERVICE_SEED = [
  { name: 'Winmgmt', label: 'WMI 提供程序' },
  { name: 'EventLog', label: 'Windows 事件日志' },
  { name: 'DefinitelyNotARealService99', label: '已被卸载的服务' }
]
/** 种子里确定在跑的服务数（Winmgmt / EventLog） */
const SERVICE_SEED_RUNNING = 2
/** 种子里确定不在跑的条数（那个不存在的名字）——侧栏徽标与面板读数都该等于它 */
const SERVICE_SEED_MISSING = 1

/** 启动项的五个合法来源，顺序即页面上的分组顺序 */
const STARTUP_SOURCES = [
  'registry-hkcu',
  'registry-hklm',
  'registry-hklm-wow',
  'folder-user',
  'folder-common'
]

const MEM_TOTAL = 8 * 1024 ** 3

function trendSeed(now) {
  const points = []
  // 24 小时窗内：每小时一个；TREND_SHAPE 最旧在前，所以时间戳要倒过来取
  for (let index = 0; index < TREND_24H_HOURLY; index++) {
    const shape = TREND_SHAPE[index]
    const hoursAgo = TREND_24H_HOURLY - 1 - index
    points.push({
      at: now - hoursAgo * 3600e3,
      cpuPercent: shape.cpu,
      memUsed: Math.round((shape.mem / 100) * MEM_TOTAL),
      memTotal: MEM_TOTAL,
      rxBps: 1024 * (index + 1),
      txBps: 512 * (index + 1)
    })
  }
  // 24 小时外、7 天窗内：每 6 小时一个，CPU 一律低于窗内峰值
  for (let k = 0; k < TREND_OLD_COUNT; k++) {
    points.push({
      at: now - (30 + k * 6) * 3600e3,
      cpuPercent: 12.5,
      memUsed: Math.round(0.52 * MEM_TOTAL),
      memTotal: MEM_TOTAL,
      rxBps: null,
      txBps: null
    })
  }
  return points
}

function check(name, ok, detail = '') {
  // 标记用 ASCII：中文控制台会把 ✓/✗ 转码成同一个字符（踩过一次，光看日志分不出通过没有）
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${name}${detail ? `  （${detail}）` : ''}`)
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures++
}

function readSmoke(file) {
  try {
    return JSON.parse(readFileSync(join(smokeDir, file), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 跑一轮冒烟；返回 `{ exited, lastAt }`。
 * `lastAt` = 种子里最新一条的时间戳，断言「最近一次」读数时用。
 */
async function runRound(theme) {
  const userDataDir = join(tmpdir(), `ops-cabin-smoke-e2e-userdata-${theme}`)
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(smokeDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })

  // 种一份确定的清理历史：总览的统计图要能按已知读数对账。
  // 写进隔离的 userData 目录，不碰真实用户的 clean-history.json。
  // 故意按「新 → 旧」倒序写盘：读回时必须自己排序，别靠写入顺序碰巧成立。
  const now = Date.now()
  const seeded = SEED.map(({ ago, ...rest }) => ({ at: now - ago, ...rest }))
  writeFileSync(join(userDataDir, 'clean-history.json'), JSON.stringify([...seeded].reverse()), 'utf8')
  const lastAt = Math.max(...seeded.map((entry) => entry.at))

  // 趋势种子：同样隔离在 userData 里，让趋势图的点数与峰值都可对账
  const trendPoints = trendSeed(now)
  writeFileSync(join(userDataDir, 'trend.json'), JSON.stringify(trendPoints), 'utf8')

  // 服务关注清单：让端口页的服务面板有确定的三行可对账（含一个不存在的服务名）
  writeFileSync(
    join(userDataDir, 'service-watch.json'),
    JSON.stringify(
      SERVICE_SEED.map((item, index) => ({ ...item, addedAt: now - (SERVICE_SEED.length - index) * 1000 })),
      null,
      2
    ),
    'utf8'
  )

  const env = {
    ...process.env,
    OPS_CABIN_SMOKE: '1',
    OPS_CABIN_SMOKE_DRIVE: '1',
    OPS_CABIN_SMOKE_EXIT: '1',
    /*
     * 假版本号：让「发现新版本」这条通知分支不必真的联网、也不必真的存在新版。
     * 它同时会让设置页的更新区块显示「模拟更新模式」——截图里看得出来是自检在跑，
     * 这正是我们要的（不是要把假状态伪装成真状态）。
     */
    OPS_CABIN_FAKE_UPDATE: '9.9.9'
  }
  /*
   * ELECTRON_RUN_AS_NODE 从宿主环境漏进来会让 electron.exe 退化成纯 Node ——
   * 没有 app、没有 BrowserWindow，主进程加载到 electron-updater 就炸
   * （报 `Cannot read properties of undefined (reading 'getVersion')`，
   * 栈底会看到 Node.js 的版本号，而不是 Electron）。
   * 这是宿主环境的事，不该要求每次调用都记得清，在这里删掉。
   */
  delete env['ELECTRON_RUN_AS_NODE']
  if (theme === 'light' || theme === 'dark') env['OPS_CABIN_SMOKE_THEME'] = theme

  /*
   * 子进程的输出接进日志文件而不是丢掉。
   *
   * GUI 进程挂了往往什么都不留（冒烟文件一个都写不出来），这时唯一的线索
   * 就是它打到 stderr 的崩溃栈。丢掉输出的代价是「94 项全红但不知为何」——
   * 上一次踩到 ELECTRON_RUN_AS_NODE 就是这么被瞒过去的。
   */
  const childLog = join(tmpdir(), `ops-cabin-smoke-${theme}.log`)
  const logFd = openSync(childLog, 'w')
  const child = spawn(
    electronExe,
    ['.', `--user-data-dir=${userDataDir}`],
    { cwd: root, stdio: ['ignore', logFd, logFd], env }
  )

  const exited = await Promise.race([
    new Promise((resolve) => child.on('exit', () => resolve(true))),
    wait(180000).then(() => false)
  ])
  closeSync(logFd)
  if (!exited) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
    return { exited: false, lastAt, childLog }
  }
  return { exited: true, lastAt, childLog }
}

console.log('== 构建 ==')
const build = spawnSync('pnpm build', { cwd: root, shell: true, encoding: 'utf8' })
if (build.status !== 0) {
  console.log(build.stdout ?? '')
  console.error(build.stderr ?? '')
  console.error('构建失败，中止')
  process.exit(1)
}

for (const theme of ['light', 'dark']) {
  console.log(`== 冒烟轮次：${theme} ==`)
  const { exited, lastAt, childLog } = await runRound(theme)
  check('冒烟完成后进程自动退出', exited)

  // 一个都没写出来 = 应用没进到冒烟流程。把子进程日志的尾巴打出来：
  // 否则后面几十项会一起红，却完全看不出是挂在启动、构建还是驱动脚本上
  if (!existsSync(join(smokeDir, 'boot.json'))) {
    console.log(`  [!] 冒烟没有产出任何文件 —— 子进程日志（${childLog}）末尾：`)
    const tail = readFileSync(childLog, 'utf8').split('\n').slice(-16).join('\n')
    console.log(tail.trim().length > 0 ? tail : '  （日志为空）')
  }

  // 留档到独立目录（两轮不互相覆盖）
  const archive = join(smokeDir + `-${theme}`)
  rmSync(archive, { recursive: true, force: true })
  try {
    cpSync(smokeDir, archive, { recursive: true })
  } catch {
    /* 目录不存在也随之报后面对账 */
  }

  check('done.json 落盘', existsSync(join(smokeDir, 'done.json')))
  check('无 smoke-error', !existsSync(join(smokeDir, 'smoke-error.json')))

  const boot = readSmoke('boot.json')
  const windowInfo = readSmoke('window.json')
  const tray = readSmoke('tray.json')
  const selfPort = readSmoke('self-port.json')
  const overview = readSmoke('view-overview.json')
  const winControls = readSmoke('win-controls.json')
  const sidebar = readSmoke('sidebar.json')
  const aboutMenu = readSmoke('about-menu.json')
  const disk = readSmoke('view-disk.json')
  const diskState = readSmoke('view-disk-state.json')
  const ports = readSmoke('view-ports.json')
  const settings = readSmoke('view-settings.json')
  const processes = readSmoke('view-processes.json')
  const trend = readSmoke('view-trend.json')
  const netcheck = readSmoke('view-netcheck.json')
  const hosts = readSmoke('view-hosts.json')
  const startup = readSmoke('view-startup.json')
  const tasks = readSmoke('view-tasks.json')
  const notifyLog = readSmoke('notify-log.json')
  const notifyProbe = readSmoke('notify-probe.json')

  check('boot 探针', boot !== null && typeof boot.pid === 'number')
  check('窗口几何自洽', windowInfo !== null && windowInfo.bounds.width > 0 && windowInfo.bounds.height > 0)
  check('托盘图标非空', tray !== null && tray.empty === false)
  check('自检端口已开设', selfPort !== null && selfPort.port > 0, `port=${selfPort?.port}`)

  check(
    '总览：分区与指标可见',
    overview !== null && overview.volumes >= 1 && /\d/.test(overview.cpuText ?? ''),
    `volumes=${overview?.volumes} cpu=${(overview?.cpuText ?? '').replace(/\s+/g, ' ').slice(0, 20)}`
  )
  check(
    '总览：清理统计出图（14 柱 + 30 天折线 + 读数按种子历史对账）',
    overview !== null &&
      overview.cleanupPlate === true &&
      overview.cleanupBars === 14 &&
      overview.cleanupTrend === true &&
      overview.cleanupTotal === String(SEED_TOTAL) &&
      overview.cleanupRuns === String(SEED.length),
    `plate=${overview?.cleanupPlate} bars=${overview?.cleanupBars} trend=${overview?.cleanupTrend} ` +
      `total=${overview?.cleanupTotal}/${SEED_TOTAL} runs=${overview?.cleanupRuns}/${SEED.length}`
  )
  check(
    '总览：清理统计按时间排序（倒序落盘也能认出最近一次）',
    Number(overview?.cleanupLastAt) === lastAt,
    `lastAt=${overview?.cleanupLastAt} 期望=${lastAt}`
  )
  check(
    '总览：网络读数带单位（不是 —）',
    /\/s/.test(overview?.netText ?? ''),
    (overview?.netText ?? '').replace(/\s+/g, ' ').slice(0, 60)
  )
  check(
    '总览：趋势图按种子出线（24 小时窗装下 12 个种子点，峰值达种子峰值）',
    overview?.trendPlate === true &&
      overview?.trendRange === '24h' &&
      Number(overview?.trendPoints) >= TREND_24H_HOURLY &&
      Number(overview?.trendCpuPeak) >= TREND_CPU_PEAK &&
      Number(overview?.trendCpuPeak) <= 100 &&
      (overview?.trendCpuLine ?? '').split(' ').length >= 3 &&
      (overview?.trendMemLine ?? '').split(' ').length >= 3,
    `range=${overview?.trendRange} points=${overview?.trendPoints}/${TREND_24H_HOURLY} 峰值=${overview?.trendCpuPeak}%（种子 ${TREND_CPU_PEAK}%）`
  )
  check(
    '趋势：切到 7 天窗后点数恰好多出窗外的 7 个（两种窗都受启动补点影响，故看差值）',
    Number(trend?.week?.points) - Number(trend?.day?.points) === TREND_OLD_COUNT &&
      trend?.week?.range === '7d' &&
      Number(trend?.week?.cpuVertices) === Number(trend?.week?.points),
    `24h=${trend?.day?.points} 7d=${trend?.week?.points} 差值=${Number(trend?.week?.points) - Number(trend?.day?.points)}（期望 ${TREND_OLD_COUNT}）`
  )
  check(
    '进程榜：切档后行序跟着换（CPU 档降序且不超 100%）',
    (() => {
      const cpuValues = processes?.cpu?.values ?? []
      const memValues = processes?.mem?.values ?? []
      const cpuDesc = cpuValues.every((value, index) => index === 0 || cpuValues[index - 1] >= value)
      const memDesc = memValues.every((value, index) => index === 0 || memValues[index - 1] >= value)
      return (
        processes?.mem?.sort === 'mem' &&
        processes?.cpu?.sort === 'cpu' &&
        (processes?.mem?.rows ?? 0) > 0 &&
        (processes?.cpu?.rows ?? 0) > 0 &&
        memDesc &&
        cpuDesc &&
        cpuValues.every((value) => value >= 0 && value <= 100)
      )
    })(),
    `内存档 ${processes?.mem?.rows} 行降序=${(processes?.mem?.values ?? []).every((v, i, a) => i === 0 || a[i - 1] >= v)} · ` +
      `CPU 档 ${processes?.cpu?.rows} 行最大=${Math.max(...(processes?.cpu?.values ?? [0]))}%`
  )
  check(
    '联网体检：六条探针出结论（结论本身随网络状况变，只验形状）',
    // 断言的是「仪表灯状态」，不是结论枚举：面板把 fail 映射成 danger 灯
    netcheck?.running === 'false' &&
      (netcheck?.rows ?? 0) >= 5 &&
      (netcheck?.labels ?? '').includes('域名解析') &&
      (netcheck?.labels ?? '').includes('SSH-over-443') &&
      (netcheck?.labels ?? '').includes('代理设置') &&
      Number.isInteger(Number(netcheck?.passed)) &&
      (netcheck?.states ?? '').split(',').every((state) => ['ok', 'danger', 'idle'].includes(state)),
    `rows=${netcheck?.rows} passed=${netcheck?.passed} states=${netcheck?.states}`
  )
  /*
   * hosts 文件体检（批次 2 第二项）：只读，判定必须可解释。
   *
   * 这里不断言「本机有几条异常」——那随机器变。断言的是**关系**：
   *   行数 = 面板记的判定数（没有偷偷丢行）、未列出的条数单独记、
   *   逐行的是否命中发布链路域名构成前缀（排序规则生效）。
   */
  const hostsWatchedSeq = hosts?.watchedSeq ?? ''
  const hostsFirstPlain = hostsWatchedSeq.indexOf('0')
  check(
    'hosts：读到文件且判定数 = 实际行数（省略的另记，不混进行数）',
    overview?.hostsPlate === true &&
      hosts !== null &&
      hosts.readable === 'true' &&
      Number(hosts.rows) > 0 &&
      Number(hosts.rows) === Number(hosts.flags) &&
      Number(hosts.omitted) >= 0 &&
      (hosts.kinds ?? '')
        .split(',')
        .filter(Boolean)
        .every((kind) => ['loopback', 'null', 'other'].includes(kind)),
    `plate=${overview?.hostsPlate} readable=${hosts?.readable} rows=${hosts?.rows} flags=${hosts?.flags} ` +
      `omitted=${hosts?.omitted} kinds=${(hosts?.kinds ?? '').slice(0, 40)}`
  )
  check(
    'hosts：命中的行数与面板读数一致',
    Number(hosts?.watchedRows) === Number(hosts?.watched),
    `watchedRows=${hosts?.watchedRows} watched=${hosts?.watched}`
  )
  check(
    'hosts：命中发布链路域名的行排在最前（否则会被成百条广告拦截淹掉）',
    // 前缀性质：出现第一个「非命中」之后，不能再有命中 —— 用「最后一条命中的下标 < 第一条非命中的下标」表达
    hostsWatchedSeq.indexOf('1') === -1 ||
      (hostsFirstPlain === -1 ||
        hostsWatchedSeq.lastIndexOf('1') < hostsFirstPlain),
    `seq=${hostsWatchedSeq.slice(0, 40)}（1 = 命中发布链路域名）`
  )
  check(
    'hosts：总览与体检段落两处读数一致（同一个事实，两处采样）',
    hosts !== null &&
      String(overview?.hostsFlags ?? '') === String(hosts.flags) &&
      String(overview?.hostsWatched ?? '') === String(hosts.watched) &&
      overview?.hostsReadable === hosts.readable,
    `overview=${overview?.hostsFlags}/${overview?.hostsWatched} 段=${hosts?.flags}/${hosts?.watched}`
  )
  check(
    '标题栏：自绘且三个窗口控件就位',
    overview !== null && overview.titlebar === true && overview.winControls === 3,
    `titlebar=${overview?.titlebar} controls=${overview?.winControls}`
  )
  check(
    '窗口控制：最大化往返后图标切还原态',
    winControls !== null && winControls.maxLabel === '还原' && winControls.restoredLabel === '最大化',
    `max=${winControls?.maxLabel} restored=${winControls?.restoredLabel} state=${JSON.stringify(winControls?.winStateAfter ?? null)}`
  )
  check(
    '侧栏：收起/展开往返',
    sidebar !== null && sidebar.collapsedState === 'true' && sidebar.expandedState === 'false',
    `collapsed=${sidebar?.collapsedState} expanded=${sidebar?.expandedState}`
  )
  /*
   * 侧栏常驻状态（批次 2 第一项）。
   *
   * 徽标是「不看页面也知道有没有事」的唯一出口，所以这里验三件事：
   *   1. 导航多了一项「启动项」，且没把原来四项挤掉（顺序也照旧）；
   *   2. 徽标形状合法 —— tone 只能是四档、读数不能是空串（空徽标等于没信号还占位置）；
   *   3. 端口徽标的内容与种子对得上 —— 这是唯一一个由种子决定的读数，
   *      也是「侧栏与页面同一套判据」的锚点。
   */
  const navLabels = (overview?.navLabels ?? '').split(',').filter(Boolean)
  check(
    /*
     * 导航项数与标签。
     *
     * 批次 3 加了「体检」，6 项是**设计值**，不是随机器变的数 —— 所以写死。
     * 但断言里同时钉住「原五项仍在」：新增一项时最容易发生的事是把某一项挤掉，
     * 那种错按 count 单独的断言抓不到（5 + 1 - 1 还是 5）。
     */
    '侧栏：导航 6 项（新增「体检」）且原五项仍在',
    overview?.navCount === 6 &&
      navLabels.length === 6 &&
      ['总览', '磁盘', '端口', '启动项', '体检', '设置'].every((want) =>
        navLabels.some((label) => label.startsWith(want))
      ),
    `count=${overview?.navCount} labels=${overview?.navLabels}`
  )
  // 徽标串形如 `nav-badge-disk:idle=剩 126 GB|nav-badge-ports:warn=服务 1 不在跑`
  const badges = overview?.navBadges ?? ''
  const badgeParts = badges.split('|').filter(Boolean)
  check(
    '侧栏：徽标形状合法（tone 属四档、读数非空）',
    badgeParts.length > 0 &&
      badgeParts.every((part) => {
        const [head, text] = part.split('=')
        const [key, tone] = (head ?? '').split(':')
        return (
          (key ?? '').startsWith('nav-badge-') &&
          ['ok', 'warn', 'danger', 'idle'].includes(tone) &&
          (text ?? '').trim().length > 0
        )
      }),
    badges || '（一个徽标都没有）'
  )
  const portBadge = badgeParts.find((part) => part.startsWith('nav-badge-ports:')) ?? ''
  check(
    `侧栏：端口徽标记下种子里的空壳服务（应读作 ${SERVICE_SEED_MISSING} 项不在跑）`,
    portBadge.startsWith(`nav-badge-ports:warn=服务 ${SERVICE_SEED_MISSING} `) && portBadge.includes('不在跑'),
    portBadge || '（无端口徽标）'
  )
  // 收起态：徽标退化成灯点，且读数折进 aria-label（状态不能只靠颜色）
  const collapsedDots = (sidebar?.collapsed?.dots ?? '').split(',').filter(Boolean)
  check(
    '侧栏：收起后徽标让位给灯点，读数折进 aria-label',
    sidebar?.collapsed?.badges === 0 &&
      collapsedDots.length >= 1 &&
      collapsedDots.includes('nav-dot-ports') &&
      /·/.test(sidebar?.collapsed?.labels ?? '') &&
      /服务/.test(sidebar?.collapsed?.labels ?? ''),
    `badges=${sidebar?.collapsed?.badges} dots=${sidebar?.collapsed?.dots} labels=${(sidebar?.collapsed?.labels ?? '').slice(0, 70)}`
  )
  check(
    '侧栏：左下角是主题三档（无版本号、无 Electron），活动档跟随主题',
    overview?.themeOptions === 3 &&
      overview?.themeActive === `theme-${theme}` &&
      !/Electron/i.test(overview?.sidebarText ?? 'Electron') &&
      !/v\d+\.\d+\.\d+/.test(overview?.sidebarText ?? ''),
    `options=${overview?.themeOptions} active=${overview?.themeActive}（本轮主题 ${theme}）`
  )
  check(
    '关于：菜单三项 + 点版本开弹窗（版本/运行时/GitHub 入口齐）',
    overview?.aboutTrigger === true &&
      aboutMenu?.open === true &&
      aboutMenu?.closed === true &&
      /^v\d+\.\d+\.\d+$/.test(aboutMenu?.version ?? '') &&
      aboutMenu?.items === 3 &&
      aboutMenu?.dialog?.open === true &&
      aboutMenu?.dialogClosed === true &&
      /^v\d+\.\d+\.\d+$/.test(aboutMenu?.dialog?.version ?? '') &&
      aboutMenu?.dialog?.github === true,
    `items=${aboutMenu?.items} dialog=${aboutMenu?.dialog?.open}/${aboutMenu?.dialogClosed} github=${aboutMenu?.dialog?.github} repo=${aboutMenu?.dialog?.repo}`
  )
  check(
    '磁盘：真实扫描出结果',
    disk !== null && disk.rows >= 1,
    `rows=${disk?.rows}${disk?.rows >= 1 ? '' : ` state=${diskState?.stateText ?? '—'}`}`
  )
  check(
    '端口：列出监听且包含自检端口',
    ports !== null && ports.rows > 10 && ports.sawSelfPort === true,
    `rows=${ports?.rows} self=${ports?.sawSelfPort}`
  )
  /*
   * 服务关注清单（批次 2 第三项）。
   *
   * 种子的三行是确定的：两个受保护服务必然在跑（WMI 提供程序自己就在响应查询），
   * 一个不存在的名字必然 missing。顺带验「查不到也要返回条目」——
   * 采集若把查不到的名字直接丢掉，用户会以为自己从没关注过它。
   */
  const serviceNames = (ports?.serviceNames ?? '').split(',').filter(Boolean).map((name) => name.toLowerCase())
  const serviceStates = (ports?.serviceStates ?? '').split(',').filter(Boolean)
  const countServiceState = (want) => serviceStates.filter((state) => state === want).length
  const serviceNotRunning = countServiceState('down') + countServiceState('missing')
  check(
    '端口页：服务关注一节就位，种下的三行都读回来了',
    ports?.servicesPlate === true &&
      ports?.servicePanel === true &&
      Number(ports?.serviceCount) === SERVICE_SEED.length &&
      Number(ports?.serviceRows) === SERVICE_SEED.length &&
      SERVICE_SEED.every((item) => serviceNames.includes(item.name.toLowerCase())),
    `count=${ports?.serviceCount} rows=${ports?.serviceRows} names=${ports?.serviceNames}`
  )
  check(
    `端口页：受保护服务读作在跑、空壳服务读作不在了（期望 ${SERVICE_SEED_RUNNING} 在跑 / ${SERVICE_SEED_MISSING} 不在）`,
    countServiceState('running') === SERVICE_SEED_RUNNING &&
      countServiceState('missing') === SERVICE_SEED_MISSING &&
      serviceStates.every((state) =>
        ['running', 'down', 'disabled', 'missing', 'pending', 'unknown'].includes(state)
      ),
    `states=${ports?.serviceStates}`
  )
  check(
    '服务：「不在跑」只数停了与不在了（禁用与切换中都不算异常）',
    Number(ports?.serviceDown) === serviceNotRunning && Number(ports?.serviceDown) === SERVICE_SEED_MISSING,
    `data-down=${ports?.serviceDown} 行内可数出=${serviceNotRunning} text=${(ports?.serviceText ?? '').slice(0, 60)}`
  )
  check(
    '服务：侧栏徽标与面板同一个数（两处口径必须一致，否则用户会怀疑所有读数）',
    portBadge.includes(`服务 ${ports?.serviceDown} `),
    `侧栏「${portBadge || '无'}」· 面板 ${ports?.serviceDown}`
  )
  /*
   * 启动项清单（批次 2 第四项，独立成页）。
   *
   * 这一页最容易做错的是口径：统计块的「路径失效」只算**启用中**的项，
   * 而行的灯若按「路径没了就亮」来判，两者就会各说各话 ——
   * 点进「仅失效」看到的条数和上面的读数对不上。所以核心断言是
   * 「仅失效档的行数 === 统计块记的失效数」，它同时能抓住两头：
   * 灯多亮了（把已禁用的残留也当失效），或数字少算了。
   */
  const startupAll = startup?.all ?? {}
  const startupInvalid = startup?.invalid ?? {}
  const startupStates = String(startupAll.states ?? '').split(',').filter(Boolean)
  const countStartupState = (want) => startupStates.filter((state) => state === want).length
  const startupSources = String(startupAll.sources ?? '').split(',').filter(Boolean)
  check(
    '启动项：清单出条目且每一项都渲染了，状态都在四档之内',
    Number(startupAll.total) > 0 &&
      Number(startupAll.rows) === Number(startupAll.total) &&
      startupStates.length === Number(startupAll.total) &&
      startupStates.every((state) => ['ok', 'disabled', 'invalid', 'stale'].includes(state)),
    `total=${startupAll.total} rows=${startupAll.rows} states=${String(startupAll.states ?? '').slice(0, 70)} ` +
      `text=${(startupAll.text ?? '').slice(0, 50)}`
  )
  check(
    '启动项：统计块的读数与行状态逐个对得上（已禁用的残留算「已禁用」不算「失效」）',
    Number(startupAll.invalid) === countStartupState('invalid') &&
      Number(startupAll.disabled) === countStartupState('disabled') + countStartupState('stale'),
    `失效 ${startupAll.invalid}/${countStartupState('invalid')} · ` +
      `已禁用 ${startupAll.disabled}/${countStartupState('disabled') + countStartupState('stale')}`
  )
  check(
    '启动项：切「仅失效」档后只剩失效项，条数 = 统计块记的失效数',
    Number(startupInvalid.rows) === Number(startupAll.invalid) &&
      String(startupInvalid.states ?? '')
        .split(',')
        .filter(Boolean)
        .every((state) => state === 'invalid'),
    `仅失效档 ${startupInvalid.rows} 行 / 统计块 ${startupAll.invalid}；states=${startupInvalid.states}`
  )
  check(
    '启动项：按来源分组，分组顺序固定（五个来源的子序列，不按条数排）',
    startupSources.length >= 1 &&
      startupSources.length === Number(startupAll.groups) &&
      startupSources.every((source) => STARTUP_SOURCES.includes(source)) &&
      // 子序列：每一项在固定表里的下标都必须比前一项靠后（顺序稳定才好找）
      startupSources.every(
        (source, index) =>
          index === 0 || STARTUP_SOURCES.indexOf(startupSources[index - 1]) < STARTUP_SOURCES.indexOf(source)
      ),
    `groups=${startupAll.groups} sources=${startupAll.sources}`
  )
  /*
   * 计划任务清单（批次 3 第一项，与启动项同一页的第二档）。
   *
   * 核心口径：「需留意」= 启用中且（上次运行失败 或 可执行文件不在）。
   * 这条判据最容易做错的两头是 ——
   *   ① 按 LastTaskResult !== 0 判失败：会把 0x41301（正在运行）和 0x41303（尚未运行）
   *      全报成故障，本机 17 个任务里有一半是这两个值，假警报会占多数；
   *   ② 把已禁用的任务也点灯：禁用的任务根本不会跑，报故障是让人去修一个没在跑的东西。
   * 所以断言「切到仅需留意档后的行数 === 统计块的读数」，它同时能抓住两头。
   */
  const tasksAll = tasks?.all ?? {}
  const tasksAttention = tasks?.attention ?? {}
  const tasksDisabled = tasks?.disabled ?? {}
  const taskStates = String(tasksAll.states ?? '').split(',').filter(Boolean)
  const countTaskState = (want) => taskStates.filter((state) => state === want).length
  const taskFolders = String(tasksAll.folders ?? '').split(',').filter(Boolean)
  check(
    '计划任务：切到第二档后清单出条目，状态都在四档之内',
    tasksAll.tab === 'tasks' &&
      Number(tasksAll.total) > 0 &&
      Number(tasksAll.rows) === Number(tasksAll.total) &&
      taskStates.length === Number(tasksAll.total) &&
      taskStates.every((state) => ['ok', 'disabled', 'failing', 'missing'].includes(state)),
    `tab=${tasksAll.tab} total=${tasksAll.total} rows=${tasksAll.rows} states=${String(tasksAll.states ?? '').slice(0, 70)} ` +
      `text=${(tasksAll.text ?? '').slice(0, 50)}`
  )
  check(
    '计划任务：统计块与行状态逐个对得上（已禁用的不算「需留意」）',
    Number(tasksAll.attention) === countTaskState('failing') + countTaskState('missing') &&
      Number(tasksAll.disabled) === countTaskState('disabled'),
    `需留意 ${tasksAll.attention}/${countTaskState('failing') + countTaskState('missing')} · ` +
      `已禁用 ${tasksAll.disabled}/${countTaskState('disabled')}`
  )
  check(
    '计划任务：切「仅需留意」档后只剩失败与失效，条数 = 统计块记的读数',
    Number(tasksAttention.rows) === Number(tasksAll.attention) &&
      String(tasksAttention.states ?? '')
        .split(',')
        .filter(Boolean)
        .every((state) => state === 'failing' || state === 'missing'),
    `仅需留意档 ${tasksAttention.rows} 行 / 统计块 ${tasksAll.attention}；states=${tasksAttention.states}`
  )
  check(
    '计划任务：切「已禁用」档后只剩禁用项，条数 = 统计块记的读数',
    Number(tasksDisabled.rows) === Number(tasksAll.disabled) &&
      String(tasksDisabled.states ?? '')
        .split(',')
        .filter(Boolean)
        .every((state) => state === 'disabled'),
    `已禁用档 ${tasksDisabled.rows} 行 / 统计块 ${tasksAll.disabled}；states=${tasksDisabled.states}`
  )
  check(
    '计划任务：跳过的系统任务数与全机总数自洽（列出 + 跳过 ≤ 全机）',
    Number(tasksAll.scanned) > 0 &&
      Number(tasksAll.skipped) > 0 &&
      Number(tasksAll.total) + Number(tasksAll.skipped) <= Number(tasksAll.scanned),
    `全机 ${tasksAll.scanned} = 列出 ${tasksAll.total} + 跳过 ${tasksAll.skipped} + 未识别`
  )
  check(
    '计划任务：没有漏网的 \\Microsoft 系统任务（它们全被跳过而不是混进清单）',
    taskFolders.every((folder) => !folder.toLowerCase().startsWith('\\microsoft')),
    `folders=${tasksAll.folders}`
  )
  check(
    '计划任务：按文件夹分组，组数 = 去重后的文件夹数，且分组标题不留空',
    taskFolders.length === Number(tasksAll.groups) &&
      taskFolders.length === new Set(taskFolders).size &&
      taskFolders.every((folder) => folder.length > 0),
    `groups=${tasksAll.groups} folders=${taskFolders.length}`
  )
  check(
    '计划任务：行上的状态与三档筛选互斥且完备（每一行都恰好落在一档里）',
    countTaskState('failing') +
      countTaskState('missing') +
      countTaskState('disabled') +
      countTaskState('ok') ===
      Number(tasksAll.total),
    `失败 ${countTaskState('failing')} + 失效 ${countTaskState('missing')} + 禁用 ${countTaskState('disabled')} + 正常 ${countTaskState('ok')} = ${tasksAll.total}`
  )
  check(
    '计划任务：已禁用的行不显示「下次 X」（禁用的任务不会在那个点跑）',
    Number(tasksAll.disabledWithNext) === 0,
    `已禁用 ${tasksAll.disabled} 行，其中 ${tasksAll.disabledWithNext} 行印了下次时间`
  )
  check(
    '计划任务：没有排期的任务不印成「下次 —」（读起来像出错）',
    Number(tasksAll.dashNext) === 0,
    `dashNext=${tasksAll.dashNext}`
  )
  /*
   * 系统体检（批次 3 第二项）：四段 PowerShell 并发采集，只读。
   *
   * 这里同样不断言「本机有几件异常」——那随机器变。断言的是**关系与口径**：
   *   ① 统计块的读数 === 明细的行数（两处各写一份判据就会对不上）；
   *   ② 待处理文件队列**永远**不算「要求重启」（它是应用自己排的延迟删除队列，
   *      本机 12 条登记里同一个文件被登记了 3 次 —— 按它报警等于叫用户白重启）；
   *   ③ 「已禁用」设备单列一档，不算故障（同一套纪律第五次出现）。
   */
  const health = readSmoke('view-health.json')
  const healthRebootLevels = String(health?.rebootLevels ?? '').split(',').filter(Boolean)
  const healthDiskHealths = String(health?.diskHealths ?? '').split(',').filter(Boolean)
  const healthDeviceCodes = String(health?.deviceCodes ?? '').split(',').filter(Boolean)
  const healthLogWindows = String(health?.logWindows ?? '').split(',').filter(Boolean)
  const healthLogProviders = String(health?.logProviders ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
  check(
    '体检：结论块就绪，四个读数都不是占位符',
    health?.state === 'ready' &&
      String(health?.uptime ?? '').length > 0 &&
      Number(health?.reboot) >= 0 &&
      Number(health?.deviceProblems) >= 0 &&
      Number(health?.statDisks) > 0 &&
      Number(health?.statLogs) === 2,
    `state=${health?.state} uptime=${health?.uptime} reboot=${health?.reboot} 问题设备=${health?.deviceProblems} ` +
      `盘=${health?.statDisks} 日志=${health?.statLogs}`
  )
  check(
    '体检：三处重启标记齐全，性质都在三档之内',
    Number(health?.rebootRows) === 3 &&
      ['cbs', 'windows-update', 'file-rename'].every((source) =>
        String(health?.rebootSources ?? '').split(',').includes(source)
      ) &&
      healthRebootLevels.length === 3 &&
      healthRebootLevels.every((level) => ['required', 'advisory', 'clear'].includes(level)),
    `sources=${health?.rebootSources} levels=${health?.rebootLevels}`
  )
  check(
    '体检：统计块的「待重启」= 标了「要求重启」的行数',
    Number(health?.reboot) === Number(health?.rebootRequiredRows),
    `读数 ${health?.reboot} / required 行 ${health?.rebootRequiredRows}`
  )
  /*
   * 关键回归：待处理文件队列不是重启要求。
   *
   * PendingFileRenameOperations 常被当成「要求重启」，但本机 12 条登记里
   * `.atrust.running` 与 `force_show` 各被登记了 3 次 —— 同一个操作重复登记，
   * 说明写队列的应用根本没把它当重启要求。算成「要求重启」会让用户白重启一次。
   */
  check(
    '体检：待处理文件队列不算「要求重启」（它只是应用排的延迟删除）',
    health?.rebootFileLevel !== 'required',
    `file-rename 档位 = ${health?.rebootFileLevel}`
  )
  check(
    '体检：磁盘行数 = 统计块读数，健康档都在四档之内，且有系统盘',
    Number(health?.diskRows) === Number(health?.statDisks) &&
      healthDiskHealths.length === Number(health?.statDisks) &&
      healthDiskHealths.every((value) => ['none', '0', '1', '2', '5'].includes(value)) &&
      Number(health?.systemDisks) >= 1,
    `行 ${health?.diskRows} / 读数 ${health?.statDisks} · healths=${health?.diskHealths} · 系统盘 ${health?.systemDisks}`
  )
  check(
    '体检：需留意的磁盘数 = 健康档非 0 的盘数（读不到与「未知」都算需留意）',
    Number(health?.badDisks) === healthDiskHealths.filter((value) => value !== '0').length,
    `${health?.badDisks} / ${healthDiskHealths.filter((v) => v !== '0').length}（${health?.diskHealths}）`
  )
  check(
    '体检：设备分档互斥完备，且「已禁用」与「有问题」分开计数',
    Number(health?.deviceRows) === Number(health?.deviceProblemRows) + Number(health?.deviceDisabledRows) &&
      Number(health?.deviceProblems) === Number(health?.deviceProblemRows) &&
      Number(health?.deviceDisabled) === Number(health?.deviceDisabledRows) &&
      healthDeviceCodes.every((code) => Number(code) > 0),
    `行 ${health?.deviceRows} = 问题 ${health?.deviceProblemRows} + 禁用 ${health?.deviceDisabledRows} · codes=${health?.deviceCodes}`
  )
  check(
    '体检：两条日志都带统计窗口（否则「16 条」没有意义）',
    Number(health?.logBlocks) === 2 &&
      String(health?.logNames ?? '')
        .split(',')
        .filter(Boolean)
        .every((name) => ['System', 'Application'].includes(name)) &&
      healthLogWindows.length === 2 &&
      healthLogWindows.every((days) => Number(days) > 0),
    `logs=${health?.logNames} windows=${health?.logWindows}`
  )
  check(
    '体检：日志的来源行数 = 面板记的来源数（没有偷偷截断展示）',
    Number(health?.providerRows) === healthLogProviders.reduce((sum, value) => sum + value, 0),
    `行 ${health?.providerRows} / 记 ${health?.logProviders}`
  )
  check(
    '体检：统计块的意外关机数与明细行数一致，且只收 41 / 6008',
    Number(health?.statCrashes) === Number(health?.crashRows) &&
      String(health?.crashIds ?? '')
        .split(',')
        .filter(Boolean)
        .every((id) => id === '41' || id === '6008'),
    `读数 ${health?.statCrashes} / 行 ${health?.crashRows} · ids=${health?.crashIds}`
  )
  check(
    '设置：六个分组就位',
    settings !== null &&
      settings.themePicker &&
      settings.notifySwitch &&
      settings.whitelist &&
      settings.scanPlan &&
      settings.dangerZone,
    JSON.stringify(settings ?? {}).slice(0, 80)
  )
  check(
    '设置：通知分组四类信号 + 重复提醒 + 安静时段共六个开关就位',
    settings?.notifyService === true &&
      settings?.notifyScan === true &&
      settings?.notifyUpdate === true &&
      settings?.notifySustained === true &&
      settings?.quietSwitch === true,
    `service=${settings?.notifyService} scan=${settings?.notifyScan} update=${settings?.notifyUpdate} ` +
      `sustained=${settings?.notifySustained} quiet=${settings?.quietSwitch}`
  )
  check(
    '设置：安静时段关闭时两个时刻输入不出现（出现了就是「关着却占着位置」）',
    Number(settings?.quietFieldsWhileOff) === 0,
    `fields=${settings?.quietFieldsWhileOff}`
  )
  check(
    '设置：打开安静时段后出现起止两个时刻输入，并写明此刻正在静音',
    notifyProbe?.quietControls?.start === true &&
      notifyProbe?.quietControls?.end === true &&
      String(notifyProbe?.quietControls?.note ?? '').includes('静音'),
    `start=${notifyProbe?.quietControls?.start} end=${notifyProbe?.quietControls?.end} note=${notifyProbe?.quietControls?.note}`
  )

  /*
   * 通知出口：三条判定分支（shown / quiet / off）必须在**真实路径**上验过。
   *
   * 记录来自通知出口自己写的 notify-log.json；触发源是自检开的三条端口服务器
   * 被逐个关掉（真 release 事件，端口盯梢 → 变化检测 → 通知出口整条链都参与）。
   * 断言按「结局 + 端口号」定位记录，不猜顺序、也不猜总数 ——
   * 自动检查更新会另外插一条 kind='update'。
   */
  const notifyRecords = Array.isArray(notifyLog?.records) ? notifyLog.records : []
  const portRecords = notifyRecords.filter((record) => record.kind === 'port')
  const probes = Array.isArray(notifyProbe?.ports) ? notifyProbe.ports : []
  const recordFor = (port, outcome) =>
    portRecords.find(
      (record) => record.outcome === outcome && String(record.body ?? '').includes(String(port))
    )
  check(
    '通知：三条分支各走一次真实路径（shown / quiet / off）',
    probes.length === 3 &&
      recordFor(probes[0], 'shown') !== undefined &&
      recordFor(probes[1], 'quiet') !== undefined &&
      recordFor(probes[2], 'off') !== undefined,
    `probe=${probes.join(',')} 记录=${portRecords.map((r) => r.outcome).join(',')}`
  )
  /*
   * 恰好三条，一条不多。
   *
   * 「各有一条」这种写法抓不到假警报 —— 自检第一版就真踩过：三条新关注的端口
   * 齐刷刷报了一次「被占用」，因为加关注时用的「最近快照」是旧的、里面还没有
   * 它们。多出来的那条记录是假警报，但按 outcome 逐条找是找得到的（shown 那条
   * 一样能对上），所以必须同时钉住**总数**。
   */
  check(
    '通知：关端口只报该报的那几条（新关注的端口不产生「刚被占用」的假警报）',
    portRecords.length === 3,
    `共 ${portRecords.length} 条：${portRecords.map((r) => r.body).join(' / ')}`
  )
  check(
    '通知：被安静时段挡下的那条记下了当时的区间（「为什么没弹」要能自答）',
    String(recordFor(probes[1], 'quiet')?.quiet ?? '').length > 0,
    `quiet=${recordFor(probes[1], 'quiet')?.quiet}`
  )
  const updateRecords = notifyRecords.filter((record) => record.kind === 'update')
  check(
    '通知：同一个新版本只通知一次（自动检查 + 手动再检查不会重复打扰）',
    updateRecords.length === 1 && updateRecords[0].outcome === 'shown',
    `条数=${updateRecords.length} outcome=${updateRecords.map((r) => r.outcome).join(',')}`
  )
  check(
    '侧栏：发现新版本后「设置」亮徽标（通知可能被安静时段挡下，徽标是它最后的落点）',
    String(notifyProbe?.badgesAfterUpdate ?? '').includes('nav-badge-settings:warn='),
    String(notifyProbe?.badgesAfterUpdate ?? '')
  )
  for (const shot of [
    'screen-overview',
    'screen-overview-trend',
    'screen-overview-netcheck',
    'screen-overview-hosts',
    'screen-disk',
    'screen-ports',
    'screen-startup',
    'screen-tasks',
    'screen-health',
    'screen-health-logs',
    'screen-settings',
    'screen-settings-quiet',
    'screen-sidebar-collapsed',
    'screen-about-menu',
    'screen-about-dialog'
  ]) {
    check(`截图 ${shot}.png`, existsSync(join(smokeDir, `${shot}.png`)))
  }

  console.log(`  （留档于 ${archive}）`)
}

console.log('')
console.log(failures === 0 ? 'E2E-SMOKE 全部通过' : `E2E-SMOKE 失败 ${failures} 项`)

// 逐项结果落盘：控制台日志经编码转换就不可靠了，失败项的定位靠这份 JSON
const resultFile = join(tmpdir(), 'ops-cabin-e2e-result.json')
writeFileSync(
  resultFile,
  JSON.stringify({ failures, total: results.length, results }, null, 2),
  'utf8'
)
if (failures > 0) {
  console.log(`失败项（完整清单见 ${resultFile}）：`)
  for (const item of results.filter((entry) => !entry.ok)) {
    console.log(`  - ${item.name}${item.detail ? `  （${item.detail}）` : ''}`)
  }
}

process.exit(failures === 0 ? 0 : 1)
