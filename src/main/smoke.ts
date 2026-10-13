import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * 应用内冒烟自检（OPS_CABIN_SMOKE=1）。
 *
 * 结论写磁盘而不是 console.log —— Windows 上 GUI 进程不挂控制台，
 * 只靠 stdout 经常什么都看不到。冒烟会把「界面事实」（DOM 计数、关键文本）
 * 与截图落盘，由外部脚本（scripts/e2e-smoke.mjs）对账。
 *
 * 相关环境变量：
 *   OPS_CABIN_SMOKE=1        开启
 *   OPS_CABIN_SMOKE_EXIT=1   跑完自动退出
 *   OPS_CABIN_SMOKE_THEME    light | dark（强制主题，深浅各跑一轮）
 */

export const SMOKE = process.env['OPS_CABIN_SMOKE'] === '1'
/** 是否驱动界面走一圈（只有对账脚本 scripts/e2e-smoke.mjs 会开；其它用途只用探针写文件） */
export const SMOKE_DRIVE = process.env['OPS_CABIN_SMOKE_DRIVE'] === '1'
const SMOKE_EXIT = process.env['OPS_CABIN_SMOKE_EXIT'] === '1'
export const SMOKE_THEME = process.env['OPS_CABIN_SMOKE_THEME']

export function smokeDir(): string {
  return join(tmpdir(), 'ops-cabin-smoke')
}

export function smoke(name: string, payload: unknown): void {
  if (!SMOKE) return
  try {
    mkdirSync(smokeDir(), { recursive: true })
    writeFileSync(join(smokeDir(), `${name}.json`), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    /* 自检失败不该影响主流程 */
  }
}

/** 冒烟主流程：主进程侧驱动界面走一圈，留下事实与截图 */
export async function runSmoke(win: BrowserWindow): Promise<void> {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script, true)
  const capture = async (name: string): Promise<void> => {
    try {
      // 被遮挡的窗口可能停更合成帧，capturePage 会拿到上一页的陈旧画面
      //（曾把端口页截成磁盘页）：先把窗口提到最前，等一帧，取两次以当帧为准。
      win.moveTop()
      await wait(120)
      await win.webContents.capturePage()
      const image = await win.webContents.capturePage()
      writeFileSync(join(smokeDir(), `${name}.png`), image.toPNG())
    } catch {
      /* 截图失败不算致命 */
    }
  }
  const nav = (key: string): Promise<unknown> =>
    run(`document.querySelector('[data-testid="nav-${key}"]')?.click(); 'ok'`)
  /** radix 组件在 mousedown 激活 —— 派发完整序列而不是 .click() */
  const press = (selector: string): Promise<unknown> =>
    run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
      return true
    })()`)
  /** radix 菜单在 pointerdown 上开合 —— 必须派发真 PointerEvent（MouseEvent 不顶用） */
  const pointerDown = (selector: string): Promise<unknown> =>
    run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        pointerId: 1, isPrimary: true, pointerType: 'mouse'
      }))
      return true
    })()`)
  /** 菜单项：radix 在 pointerup 上完成选中（鼠标路径）—— 派发完整指针序列 */
  const pressPointer = (selector: string): Promise<unknown> =>
    run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }))
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      return true
    })()`)

  const servers: Server[] = []
  /** 起一个真在监听的服务端并把端口号报出来（通知自检要造真实的「端口被释放」） */
  const openPort = (): Promise<{ port: number; close: () => Promise<void> }> =>
    new Promise((resolve) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        servers.push(server)
        resolve({
          port,
          close: () =>
            new Promise<void>((done) => {
              try {
                server.close(() => done())
              } catch {
                done()
              }
            })
        })
      })
    })
  try {
    // 自检自己开一个端口：端口页必须能把它列出来
    const selfPort = await openPort()
    smoke('self-port', { port: selfPort.port })

    /* ---- 总览 ---- */
    await wait(2500)
    /*
     * 总览上有几块是异步到位的，一次轮询把它们全等齐：
     *   - 清理统计：读历史文件（IPC 往返）
     *   - 网络读数：netstat 要读两次才有速率（约 2s）
     *   - 进程榜：CPU 要有基线，首次要连采两次 PowerShell（约 3s）
     * 死等固定时长在慢机器上必然误报，所以逐条判就绪。
     */
    for (let i = 0; i < 60; i++) {
      const ready = await run(`(() => {
        const runs = document.querySelector('[data-testid="cleanup-stats"]')?.getAttribute('data-runs')
        const net = document.querySelector('[data-testid="metric-net"]')?.textContent ?? ''
        const rows = document.querySelectorAll('[data-testid="process-row"]').length
        return runs !== null && runs !== '0' && net.includes('/s') && rows > 0
      })()`)
      if (ready === true) break
      await wait(250)
    }
    /*
     * 侧栏的端口徽标要等一次 PowerShell 服务采集（冷缓存约 1.6 秒）。
     * 不等它，慢机器上会拍到一个「还没有徽标」的侧栏 —— 那是「还没读到」，
     * 不是「没有事」，两者混在一起断言就失去意义了。
     */
    for (let i = 0; i < 40; i++) {
      const ready = await run(`!!document.querySelector('[data-testid="nav-badge-ports"]')`)
      if (ready === true) break
      await wait(250)
    }
    smoke(
      'view-overview',
      await run(`({
         volumes: document.querySelectorAll('[data-testid="overview-volume"]').length,
         cpuText: document.querySelector('[data-testid="metric-cpu"]')?.textContent ?? null,
         memText: document.querySelector('[data-testid="metric-mem"]')?.textContent ?? null,
         netText: document.querySelector('[data-testid="metric-net"]')?.textContent ?? null,
         alerts: document.querySelectorAll('[data-testid="alert-item"]').length,
         titlebar: !!document.querySelector('[data-testid="titlebar"]'),
         winControls: document.querySelectorAll('[data-testid^="win-"]').length,
         aboutTrigger: !!document.querySelector('[data-testid="about-menu"]'),
         cleanupPlate: !!document.querySelector('[data-testid="overview-cleanup"]'),
         cleanupBars: document.querySelectorAll('[data-testid="cleanup-bar"]').length,
         cleanupTrend: !!document.querySelector('[data-testid="cleanup-trend"]'),
         cleanupTotal: document.querySelector('[data-testid="cleanup-stats"]')?.getAttribute('data-total-bytes') ?? null,
         cleanupRuns: document.querySelector('[data-testid="cleanup-stats"]')?.getAttribute('data-runs') ?? null,
         cleanupLastAt: document.querySelector('[data-testid="cleanup-stats"]')?.getAttribute('data-last-at') ?? null,
         trendPlate: !!document.querySelector('[data-testid="overview-trend"]'),
         trendPoints: document.querySelector('[data-testid="resource-trend"]')?.getAttribute('data-points') ?? null,
         trendRange: document.querySelector('[data-testid="resource-trend"]')?.getAttribute('data-range') ?? null,
         trendCpuPeak: document.querySelector('[data-testid="resource-trend"]')?.getAttribute('data-cpu-peak') ?? null,
         trendCpuLine: document.querySelector('[data-testid="trend-line-cpu"]')?.getAttribute('points') ?? null,
         trendMemLine: document.querySelector('[data-testid="trend-line-mem"]')?.getAttribute('points') ?? null,
         processPlate: !!document.querySelector('[data-testid="overview-processes"]'),
         netcheckPlate: !!document.querySelector('[data-testid="overview-netcheck"]'),
         hostsPlate: !!document.querySelector('[data-testid="overview-hosts"]'),
         hostsFlags: document.querySelector('[data-testid="hosts-panel"]')?.getAttribute('data-flags') ?? null,
         hostsWatched: document.querySelector('[data-testid="hosts-panel"]')?.getAttribute('data-watched') ?? null,
         hostsReadable: document.querySelector('[data-testid="hosts-panel"]')?.getAttribute('data-readable') ?? null,
         navCount: document.querySelectorAll('nav button').length,
         navLabels: Array.from(document.querySelectorAll('nav button')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).join(','),
         navBadges: Array.from(document.querySelectorAll('[data-testid^="nav-badge-"]')).map((el) => (el.getAttribute('data-testid') ?? '?') + ':' + (el.getAttribute('data-tone') ?? '?') + '=' + el.textContent.trim()).join('|'),
         sidebar: document.querySelector('[data-testid="sidebar"]')?.getAttribute('data-collapsed') ?? null,
         themeOptions: document.querySelectorAll('[data-testid="sidebar"] [role="radio"]').length,
         themeActive: document.querySelector('[data-testid="sidebar"] [role="radio"][data-active="true"]')?.getAttribute('data-testid') ?? null,
         sidebarText: document.querySelector('[data-testid="sidebar"]')?.innerText.replace(/\\n+/g, ' | ') ?? null,
         text: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 160)
       })`)
    )
    await capture('screen-overview')

    /* ---- 进程榜：切到 CPU 档，行序必须跟着变（读数要从高到低） ---- */
    const processRows = (): Promise<unknown> =>
      run(`({
         sort: document.querySelector('[data-testid="process-top"]')?.getAttribute('data-sort') ?? null,
         rows: document.querySelectorAll('[data-testid="process-row"]').length,
         values: Array.from(document.querySelectorAll('[data-testid="process-row"]')).map((el) => Number(el.getAttribute('data-value'))),
         names: Array.from(document.querySelectorAll('[data-testid="process-row"]')).slice(0, 3).map((el) => el.textContent.trim().slice(0, 24))
       })`)
    const processMem = await processRows()
    await press('[data-testid="process-sort-cpu"]')
    await wait(300)
    const processCpu = await processRows()
    smoke('view-processes', { mem: processMem, cpu: processCpu })

    /* ---- 趋势：切到 7 天窗，点数必须变多（24 小时窗装不下更早的点） ---- */
    const trendFacts = (): Promise<unknown> =>
      run(`({
         range: document.querySelector('[data-testid="resource-trend"]')?.getAttribute('data-range') ?? null,
         points: Number(document.querySelector('[data-testid="resource-trend"]')?.getAttribute('data-points') ?? -1),
         cpuVertices: (document.querySelector('[data-testid="trend-line-cpu"]')?.getAttribute('points') ?? '').trim().split(/\\s+/).filter(Boolean).length,
         memVertices: (document.querySelector('[data-testid="trend-line-mem"]')?.getAttribute('points') ?? '').trim().split(/\\s+/).filter(Boolean).length
       })`)
    const trend24h = await trendFacts()
    await press('[data-testid="trend-range-7d"]')
    await wait(300)
    const trend7d = await trendFacts()
    smoke('view-trend', { day: trend24h, week: trend7d })
    await run(`document.querySelector('[data-testid="overview-trend"]')?.scrollIntoView({ block: 'start' }); 'ok'`)
    await wait(200)
    await capture('screen-overview-trend')

    /* ---- 联网体检：真实探测（结果随网络状况变，只断言「出条目」不断言全通） ---- */
    await run(`document.querySelector('[data-testid="overview-netcheck"]')?.scrollIntoView({ block: 'start' }); 'ok'`)
    await wait(200)
    await press('[data-testid="netcheck-run"]')
    for (let i = 0; i < 60; i++) {
      const done = await run(`(() => {
        const panel = document.querySelector('[data-testid="netcheck-panel"]')
        return panel?.getAttribute('data-running') === 'false' &&
          document.querySelectorAll('[data-testid="netcheck-item"]').length >= 5
      })()`)
      if (done === true) break
      await wait(500)
    }
    smoke(
      'view-netcheck',
      await run(`({
         running: document.querySelector('[data-testid="netcheck-panel"]')?.getAttribute('data-running') ?? null,
         passed: document.querySelector('[data-testid="netcheck-panel"]')?.getAttribute('data-passed') ?? null,
         rows: document.querySelectorAll('[data-testid="netcheck-item"]').length,
         labels: Array.from(document.querySelectorAll('[data-testid="netcheck-item"]')).map((el) => el.children[1]?.textContent ?? '').join(','),
         states: Array.from(document.querySelectorAll('[data-testid="netcheck-item"] .lamp')).map((el) => el.getAttribute('data-state')).join(','),
         detail: document.querySelector('[data-testid="netcheck-item"] .num')?.textContent ?? null
       })`)
    )
    await capture('screen-overview-netcheck')

    /* ---- 域名改写（hosts）：只读，断言「读到了」+「判定可解释」 ---- */
    await run(`document.querySelector('[data-testid="overview-hosts"]')?.scrollIntoView({ block: 'start' }); 'ok'`)
    await wait(400)
    smoke(
      'view-hosts',
      await run(`({
         flags: document.querySelector('[data-testid="hosts-panel"]')?.getAttribute('data-flags') ?? null,
         watched: document.querySelector('[data-testid="hosts-panel"]')?.getAttribute('data-watched') ?? null,
         omitted: document.querySelector('[data-testid="hosts-panel"]')?.getAttribute('data-omitted') ?? null,
         readable: document.querySelector('[data-testid="hosts-panel"]')?.getAttribute('data-readable') ?? null,
         rows: document.querySelectorAll('[data-testid="hosts-flag"]').length,
         kinds: Array.from(document.querySelectorAll('[data-testid="hosts-flag"]')).map((el) => el.getAttribute('data-kind')).join(','),
         watchedRows: document.querySelectorAll('[data-testid="hosts-flag"][data-watched="true"]').length,
         // 逐行的是否命中发布链路域名（顺序敏感）：用来验「watched 排在前面」这条排序规则
         watchedSeq: Array.from(document.querySelectorAll('[data-testid="hosts-flag"]')).map((el) => el.getAttribute('data-watched') === 'true' ? '1' : '0').join(''),
         firstRow: document.querySelector('[data-testid="hosts-flag"]')?.innerText.replace(/\\n+/g, ' | ') ?? null
       })`)
    )
    await capture('screen-overview-hosts')

    // 把总览滚回顶部：后面的窗口控制与侧栏截图要在首屏做
    await run(`document.querySelector('[data-testid="overview-view"]')?.scrollTo({ top: 0 }); 'ok'`)
    await wait(200)

    /* ---- 自绘标题栏的窗口控制：点最大化 → 主进程生效 → 状态推回来把图标切成「还原」---- */
    const winLabel = (): Promise<unknown> =>
      run(`document.querySelector('[data-testid="win-maximize"]')?.getAttribute('aria-label') ?? null`)
    /** 最大化/还原走 Windows 过渡动画，状态是异步推回的 —— 轮询等到位，别死等固定毫秒 */
    const waitForWinLabel = async (expected: string): Promise<unknown> => {
      let label: unknown = null
      for (let i = 0; i < 16; i++) {
        label = await winLabel()
        if (label === expected) return label
        await wait(200)
      }
      return label
    }
    await press('[data-testid="win-maximize"]')
    const maxLabel = await waitForWinLabel('还原')
    await press('[data-testid="win-maximize"]')
    const restoredLabel = await waitForWinLabel('最大化')
    const winStateAfter = await run(`window.opsCabin.getWindowState()`)
    smoke('win-controls', { maxLabel, restoredLabel, winStateAfter })

    /* ---- 侧栏收起/展开往返（收起态留一张截图：图标态是否还对得齐） ---- */
    await press('[data-testid="sidebar-toggle"]')
    await wait(350)
    const collapsedState = await run(
      `document.querySelector('[data-testid="sidebar"]')?.getAttribute('data-collapsed') ?? null`
    )
    // 收起态：读数徽标必须让位给灯点，且状态不能只靠颜色 —— aria-label 要带上读数
    const collapsedDots = await run(`({
       badges: document.querySelectorAll('[data-testid^="nav-badge-"]').length,
       dots: Array.from(document.querySelectorAll('[data-testid^="nav-dot-"]')).map((el) => el.getAttribute('data-testid')).join(','),
       labels: Array.from(document.querySelectorAll('nav button')).map((el) => el.getAttribute('aria-label') ?? '').join(' | ')
     })`)
    await capture('screen-sidebar-collapsed')
    await press('[data-testid="sidebar-toggle"]')
    await wait(350)
    const expandedState = await run(
      `document.querySelector('[data-testid="sidebar"]')?.getAttribute('data-collapsed') ?? null`
    )
    smoke('sidebar', { collapsedState, expandedState, collapsed: collapsedDots })

    /* ---- 关于：菜单读一眼 → 点版本开弹窗 → Esc 关闭（不点检查更新/退出，避免真触发） ---- */
    await pointerDown('[data-testid="about-menu"]')
    await wait(400)
    const about = (await run(`({
       open: !!document.querySelector('[data-testid="about-menu-content"]'),
       version: document.querySelector('[data-testid="about-version"]')?.textContent ?? null,
       items: document.querySelectorAll('[data-testid^="about-item-"]').length
     })`)) as Record<string, unknown>
    await capture('screen-about-menu')

    await pressPointer('[data-testid="about-item-version"]')
    await wait(500)
    const dialog = (await run(`({
       open: !!document.querySelector('[data-testid="about-dialog"]'),
       version: document.querySelector('[data-testid="about-dialog-version"]')?.textContent ?? null,
       github: !!document.querySelector('[data-testid="about-github"]'),
       repo: document.querySelector('[data-testid="about-github"]')?.innerText.replace(/\\n+/g, ' ').trim() ?? null
     })`)) as Record<string, unknown>
    await capture('screen-about-dialog')

    await run(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`
    )
    await wait(400)
    const dialogClosed = await run(`!document.querySelector('[data-testid="about-dialog"]')`)
    const menuClosed = await run(`!document.querySelector('[data-testid="about-menu-content"]')`)
    smoke('about-menu', { ...about, closed: menuClosed, dialog, dialogClosed })

    /* ---- 磁盘页：真实扫描（safe + devCaches） ---- */
    await nav('disk')
    await wait(1200)
    await press('[data-testid="scan-start"]')
    let diskRows = 0
    // 扫描跑在 utilityProcess 里，机器忙时可能拖到一分钟以上 —— 预算给足
    for (let i = 0; i < 200; i++) {
      await wait(500)
      diskRows = Number(await run(`document.querySelectorAll('[data-testid="result-row"]').length`))
      if (diskRows > 0) break
    }
    // 0 行时把进度条文字一起落盘：是「还在扫」还是「扫完了确实没有」一眼可分
    const diskStateText =
      diskRows > 0
        ? null
        : await run(
            `document.querySelector('[data-testid="scan-progress"]')?.innerText.replace(/\\n+/g, ' | ') ?? null`
          )
    smoke(
      'view-disk',
      await run(`({
         rows: document.querySelectorAll('[data-testid="result-row"]').length,
         summary: document.querySelector('[data-testid="selection-summary"]')?.textContent ?? null,
         firstRow: document.querySelector('[data-testid="result-row"]')?.innerText.replace(/\\n+/g, ' | ') ?? null
       })`)
    )
    smoke('view-disk-state', { stateText: diskStateText })
    await capture('screen-disk')

    /* ---- 端口页：必须包含自检自己开的端口 ---- */
    await nav('ports')
    // 离开总览后监控器停采，端口页首屏要现采一次；冷启动的进程信息查询可能超过 2 秒
    await wait(5000)
    // 服务面板要另起一次 PowerShell（冷缓存约 1.6 秒）。行还没出来时断言，
    // 会把「正在读取」当成「一个都没读到」—— 空态与未就绪必须分开
    for (let i = 0; i < 40; i++) {
      const ready = await run(`document.querySelectorAll('[data-testid="service-row"]').length > 0`)
      if (ready === true) break
      await wait(250)
    }
    smoke(
      'view-ports',
      await run(`({
         rows: document.querySelectorAll('[data-testid="port-row"]').length,
         sawSelfPort: !!document.querySelector('[data-testid="port-row"][data-port="${selfPort.port}"]'),
         watchCards: document.querySelectorAll('[data-testid="watch-card"]').length,
         timeline: !!document.querySelector('[data-testid="change-timeline"]'),
         servicesPlate: !!document.querySelector('[data-testid="ports-services"]'),
         servicePanel: !!document.querySelector('[data-testid="service-watch"]'),
         serviceCount: document.querySelector('[data-testid="service-watch"]')?.getAttribute('data-count') ?? null,
         serviceDown: document.querySelector('[data-testid="service-watch"]')?.getAttribute('data-down') ?? null,
         serviceRows: document.querySelectorAll('[data-testid="service-row"]').length,
         serviceStates: Array.from(document.querySelectorAll('[data-testid="service-row"]')).map((el) => el.getAttribute('data-state')).join(','),
         serviceNames: Array.from(document.querySelectorAll('[data-testid="service-row"]')).map((el) => el.getAttribute('data-name')).join(','),
         serviceText: document.querySelector('[data-testid="service-watch"]')?.innerText.replace(/\\n+/g, ' | ').slice(0, 140) ?? null
       })`)
    )
    await capture('screen-ports')

    /* ---- 启动项页：只读清单（首次要起 PowerShell 采一次，等行出来） ---- */
    await nav('startup')
    for (let i = 0; i < 60; i++) {
      /*
       * 两个条件都要判：按钮在（视图已挂载）且不在「读取中」。
       * 只判后者时，元素还没挂载时可选链给出 undefined，取反就是「已就绪」——
       * 会在视图挂载前就退出，把「还没渲染」当成「读完了」。
       */
      const ready = await run(`(() => {
         const btn = document.querySelector('[data-testid="startup-refresh"]')
         if (!btn) return false
         return !btn.textContent.includes('读取中')
       })()`)
      if (ready === true) break
      await wait(500)
    }
    const startupFacts = (): Promise<unknown> =>
      run(`({
         total: Number(document.querySelector('[data-testid="startup-stats"]')?.getAttribute('data-total') ?? -1),
         invalid: Number(document.querySelector('[data-testid="startup-stats"]')?.getAttribute('data-invalid') ?? -1),
         disabled: Number(document.querySelector('[data-testid="startup-stats"]')?.getAttribute('data-disabled') ?? -1),
         rows: document.querySelectorAll('[data-testid="startup-row"]').length,
         groups: document.querySelectorAll('[data-testid="startup-group"]').length,
         sources: Array.from(document.querySelectorAll('[data-testid="startup-group"]')).map((el) => el.getAttribute('data-source')).join(','),
         states: Array.from(document.querySelectorAll('[data-testid="startup-row"]')).map((el) => el.getAttribute('data-state')).join(','),
         // 失败时要能一眼分出「读挂了」和「确实是空的」——带上页面上的提示原文
         text: document.querySelector('[data-testid="startup-view"]')?.innerText.replace(/\\n+/g, ' | ').slice(0, 150) ?? null
       })`)
    const startupAll = (await startupFacts()) as Record<string, unknown>
    await press('[data-testid="startup-filter-invalid"]')
    await wait(400)
    const startupOnlyInvalid = (await startupFacts()) as Record<string, unknown>
    smoke('view-startup', { all: startupAll, invalid: startupOnlyInvalid })
    await press('[data-testid="startup-filter-all"]')
    await wait(300)
    await capture('screen-startup')

    /* ---- 计划任务档：同一页的第二档（首次要起一次 COM 枚举，本机约 1.5 秒） ---- */
    await press('[data-testid="tab-tasks"]')
    for (let i = 0; i < 60; i++) {
      /*
       * 等「按钮在 且 不在读取中」两条都成立 —— 与启动项档同一个坑：
       * 只判后者时元素还没挂载，可选链给出 undefined，取反就成了「已就绪」，
       * 会在挂载前退出，把「还没渲染」当成「读完了」。
       */
      const ready = await run(`(() => {
         const btn = document.querySelector('[data-testid="tasks-refresh"]')
         if (!btn) return false
         return !btn.textContent.includes('读取中')
       })()`)
      if (ready === true) break
      await wait(500)
    }
    const taskFacts = (): Promise<unknown> =>
      run(`({
         total: Number(document.querySelector('[data-testid="tasks-stats"]')?.getAttribute('data-total') ?? -1),
         attention: Number(document.querySelector('[data-testid="tasks-stats"]')?.getAttribute('data-attention') ?? -1),
         disabled: Number(document.querySelector('[data-testid="tasks-stats"]')?.getAttribute('data-disabled') ?? -1),
         scanned: Number(document.querySelector('[data-testid="tasks-stats"]')?.getAttribute('data-scanned') ?? -1),
         skipped: Number(document.querySelector('[data-testid="tasks-stats"]')?.getAttribute('data-skipped') ?? -1),
         rows: document.querySelectorAll('[data-testid="task-row"]').length,
         groups: document.querySelectorAll('[data-testid="task-group"]').length,
         folders: Array.from(document.querySelectorAll('[data-testid="task-group"]')).map((el) => el.getAttribute('data-folder')).join(','),
         states: Array.from(document.querySelectorAll('[data-testid="task-row"]')).map((el) => el.getAttribute('data-state')).join(','),
         running: document.querySelectorAll('[data-testid="task-row"][data-running="1"]').length,
         // 没有触发器的任务不会自己跑（只在被手动调用时执行），是「手动」那一档
         manual: Array.from(document.querySelectorAll('[data-testid="task-row"]')).filter((el) => (el.getAttribute('data-triggers') ?? '') === '').length,
         // 已禁用的行不该出现「下次 X」—— 它不会在那个点跑，印出来等于说「今晚会动」
         disabledWithNext: Array.from(document.querySelectorAll('[data-testid="task-row"][data-state="disabled"]')).filter((el) => el.innerText.includes('下次')).length,
         // 没有排期的任务（登录/开机触发）不该印成「下次 —」，那读起来像出错
         dashNext: Array.from(document.querySelectorAll('[data-testid="task-row"]')).filter((el) => el.innerText.includes('下次 —')).length,
         tab: document.querySelector('[data-testid="startup-view"]')?.getAttribute('data-tab') ?? null,
         firstRow: document.querySelector('[data-testid="task-row"]')?.innerText.replace(/\\n+/g, ' | ') ?? null,
         text: document.querySelector('[data-testid="startup-view"]')?.innerText.replace(/\\n+/g, ' | ').slice(0, 200) ?? null
       })`)
    const tasksAll = (await taskFacts()) as Record<string, unknown>
    await press('[data-testid="tasks-filter-attention"]')
    await wait(400)
    const tasksAttention = (await taskFacts()) as Record<string, unknown>
    await press('[data-testid="tasks-filter-disabled"]')
    await wait(400)
    const tasksDisabled = (await taskFacts()) as Record<string, unknown>
    smoke('view-tasks', {
      all: tasksAll,
      attention: tasksAttention,
      disabled: tasksDisabled
    })
    await press('[data-testid="tasks-filter-all"]')
    await wait(300)
    await capture('screen-tasks')

    /* ---- 体检页：四段 PowerShell 并发采集（本机约 3.8 秒，等结论块就绪） ---- */
    await nav('health')
    for (let i = 0; i < 80; i++) {
      /*
       * 与前两处同一个坑，第三种写法：这里判的是根节点上的 data-state。
       * 视图还没挂载时可选链给出 undefined，与 'ready' 不等 —— 天然安全；
       * 但仍然要先判元素在，否则 `null?.getAttribute` 也是 undefined，
       * 一旦写成「不等于 loading 就算就绪」照样会提前退出。
       */
      const ready = await run(`(() => {
         const view = document.querySelector('[data-testid="health-view"]')
         if (!view) return false
         return view.getAttribute('data-state') === 'ready'
       })()`)
      if (ready === true) break
      await wait(500)
    }
    smoke(
      'view-health',
      await run(`({
         state: document.querySelector('[data-testid="health-view"]')?.getAttribute('data-state') ?? null,
         uptime: document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-uptime') ?? null,
         reboot: Number(document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-reboot') ?? -1),
         deviceProblems: Number(document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-device-problems') ?? -1),
         deviceDisabled: Number(document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-device-disabled') ?? -1),
         statDisks: Number(document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-disks') ?? -1),
         badDisks: Number(document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-bad-disks') ?? -1),
         statLogs: Number(document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-logs') ?? -1),
         statCrashes: Number(document.querySelector('[data-testid="health-stats"]')?.getAttribute('data-crashes') ?? -1),
         rebootRows: document.querySelectorAll('[data-testid="reboot-row"]').length,
         rebootSources: Array.from(document.querySelectorAll('[data-testid="reboot-row"]')).map((el) => el.getAttribute('data-source')).join(','),
         rebootLevels: Array.from(document.querySelectorAll('[data-testid="reboot-row"]')).map((el) => el.getAttribute('data-level')).join(','),
         // 统计块的「待重启」必须与标了 required 的行数相等 —— 两处各写一份判据就会对不上
         rebootRequiredRows: document.querySelectorAll('[data-testid="reboot-row"][data-level="required"]').length,
         rebootFileLevel: document.querySelector('[data-testid="reboot-row"][data-source="file-rename"]')?.getAttribute('data-level') ?? null,
         diskRows: document.querySelectorAll('[data-testid="disk-row"]').length,
         diskHealths: Array.from(document.querySelectorAll('[data-testid="disk-row"]')).map((el) => el.getAttribute('data-health')).join(','),
         systemDisks: document.querySelectorAll('[data-testid="disk-row"][data-system="1"]').length,
         // 槽位法先钉一层：健康档只有 0/1/2/5 四个真值（null 走 'none'）
         diskHealthsValid: Array.from(document.querySelectorAll('[data-testid="disk-row"]')).every((el) => ['none','0','1','2','5'].includes(el.getAttribute('data-health'))),
         deviceRows: document.querySelectorAll('[data-testid="device-row"]').length,
         deviceProblemRows: document.querySelectorAll('[data-testid="device-row"][data-level="problem"]').length,
         deviceDisabledRows: document.querySelectorAll('[data-testid="device-row"][data-level="disabled"]').length,
         deviceCodes: Array.from(document.querySelectorAll('[data-testid="device-row"]')).map((el) => el.getAttribute('data-code')).join(','),
         logBlocks: document.querySelectorAll('[data-testid="log-block"]').length,
         logNames: Array.from(document.querySelectorAll('[data-testid="log-block"]')).map((el) => el.getAttribute('data-log')).join(','),
         logTotals: Array.from(document.querySelectorAll('[data-testid="log-block"]')).map((el) => el.getAttribute('data-total')).join(','),
         logWindows: Array.from(document.querySelectorAll('[data-testid="log-block"]')).map((el) => el.getAttribute('data-window')).join(','),
         logProviders: Array.from(document.querySelectorAll('[data-testid="log-block"]')).map((el) => el.getAttribute('data-providers')).join(','),
         providerRows: document.querySelectorAll('[data-testid="log-provider"]').length,
         crashRows: document.querySelectorAll('[data-testid="crash-row"]').length,
         crashIds: Array.from(document.querySelectorAll('[data-testid="crash-row"]')).map((el) => el.getAttribute('data-id')).join(','),
         text: document.querySelector('[data-testid="health-view"]')?.innerText.replace(/\\n+/g, ' | ').slice(0, 260) ?? null
       })`)
    )
    await capture('screen-health')
    /*
     * 事件日志与意外关机在首屏之下 —— 不滚下去就没人审过它们长什么样。
     * 截图只拍可视区，所以「断言全绿」和「这一页好不好看」是两件事：
     * 上面那段 facts 把数据都取到了，但它取不到「渲染出来是不是一团糊」。
     */
    await run(`document.querySelector('[data-testid="health-view"]')?.scrollTo(0, 99999)`)
    await wait(400)
    await capture('screen-health-logs')

    /* ---- 设置页 ---- */
    await nav('settings')
    await wait(900)
    smoke(
      'view-settings',
      await run(`({
         themePicker: !!document.querySelector('[data-testid="theme-picker"]'),
         notifySwitch: !!document.querySelector('[data-testid="notify-switch"]'),
         notifyService: !!document.querySelector('[data-testid="notify-service"]'),
         notifyScan: !!document.querySelector('[data-testid="notify-scan"]'),
         notifyUpdate: !!document.querySelector('[data-testid="notify-update"]'),
         notifySustained: !!document.querySelector('[data-testid="notify-sustained"]'),
         quietSwitch: !!document.querySelector('[data-testid="quiet-switch"]'),
         whitelist: !!document.querySelector('[data-testid="whitelist-editor"]'),
         scanPlan: !!document.querySelector('[data-testid="scan-plan-editor"]'),
         dangerZone: !!document.querySelector('[data-testid="danger-zone"]'),
         // 安静时段默认关闭：两个时刻输入此刻**不该**出现（打开后才显示）
         quietFieldsWhileOff: document.querySelectorAll('[data-testid="quiet-start"], [data-testid="quiet-end"]').length,
         text: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 120)
       })`)
    )
    await capture('screen-settings')

    /*
     * ---- 通知出口：三条判定分支各走一次真实路径 ----
     *
     * 通知是极难自然触发的东西（要等一个真服务挂掉、真出现新版本），所以这里用
     * 自检自己开的端口造真实的「端口被释放」—— 端口盯梢、变化检测、通知出口
     * 三段代码全部参与，**不是绕过它们直接调 notify()**。否则自检只能证明
     * 「留档函数会写文件」，证明不了「变化真的会走到留档」。
     *
     * 三条分支：shown（正常）→ quiet（安静时段打开且覆盖此刻）→ off（信号开关关掉）。
     * 判定结果由通知出口自己留档（notify-log.json），外部脚本读它对账；
     * 这里只负责把戏演真，并把「演了什么」记下来。
     */
    const probeA = await openPort()
    const probeB = await openPort()
    const probeC = await openPort()
    const probePorts = [probeA.port, probeB.port, probeC.port]
    /**
     * 安静区间取「此刻前后各一小时」：区间长度 120 分钟必然覆盖当前分钟，
     * 而且当测试恰好跑在 23 点或 0 点前后时 start > end，顺带把跨午夜那条
     * 分支也走一遍（写死 22:00-08:00 就永远只测到其中一种形态）。
     */
    const clockOf = (offsetMinutes: number): string => {
      const base = new Date()
      base.setMinutes(base.getMinutes() + offsetMinutes)
      const pad = (value: number): string => String(value).padStart(2, '0')
      return `${pad(base.getHours())}:${pad(base.getMinutes())}`
    }
    const quietStart = clockOf(-60)
    const quietEnd = clockOf(60)

    // 订阅 + 等一拍：让「最近快照」尽量新鲜（加关注时会拿它建基线）。
    // 就算快照来不及刷新也没关系 —— 监控自己会在下一拍补基线，但那一拍必须
    // 在下面关端口之前发生，所以这里等的是一个完整采样周期 + 采集耗时。
    await run(`window.opsCabin.subscribePorts()`)
    await wait(3000)
    await run(
      `Promise.all(${JSON.stringify(probePorts)}.map((port) => window.opsCabin.addWatch({ port, label: '通知自检 ' + port })))`
    )
    await wait(4000)

    // ① 正常路径：关掉 A 的监听 → 端口释放 → 应记一条 outcome=shown
    await probeA.close()
    await wait(4000)

    // ② 安静时段：先把区间设成覆盖此刻，再关 B → 应记一条 outcome=quiet
    await run(
      `window.opsCabin.updateSettings({ quietHours: { enabled: true, start: ${JSON.stringify(quietStart)}, end: ${JSON.stringify(quietEnd)} } })`
    )
    await wait(600)
    const quietControls = await run(`({
      start: !!document.querySelector('[data-testid="quiet-start"]'),
      end: !!document.querySelector('[data-testid="quiet-end"]'),
      note: document.querySelector('[data-testid="quiet-note"]')?.textContent ?? null
    })`)
    /*
     * 留一张「安静时段打开」的截图：两个时刻输入与动态提示只在开启时出现，
     * 常规的设置页截图（默认关闭）永远拍不到它们 —— 而不看就不知道它们
     * 挤不挤、会不会把行撑变形。
     */
    await capture('screen-settings-quiet')
    await probeB.close()
    await wait(4000)

    // ③ 信号开关关掉：关掉端口通知再关 C → 应记一条 outcome=off
    await run(
      `window.opsCabin.updateSettings({ notifyOnPortChange: false, quietHours: { enabled: false, start: ${JSON.stringify(quietStart)}, end: ${JSON.stringify(quietEnd)} } })`
    )
    await wait(600)
    await probeC.close()
    await wait(4000)

    /*
     * 更新通知：OPS_CABIN_FAKE_UPDATE 注入的假版本让这条分支不必真的联网。
     * 自动检查（启动 30 秒后）多半已经通知过一次同一个版本号 —— 这里再检查一次，
     * 恰好把「同一个版本只通知一次」的去重也验证掉（记录里 update 仍然只有一条）。
     */
    await run(`window.opsCabin.checkUpdate()`)
    await wait(1200)
    /*
     * 顺手采一次侧栏徽标：发现新版本后「设置」要亮 —— 通知可能被安静时段挡下，
     * 徽标是那条消息最后的落点（挡了通知又没别处看得见，那条消息就真没了）。
     */
    const badgesAfterUpdate = await run(
      `Array.from(document.querySelectorAll('[data-testid^="nav-badge-"]')).map((el) => (el.getAttribute('data-testid') ?? '?') + ':' + (el.getAttribute('data-tone') ?? '?') + '=' + el.textContent.trim()).join('|')`
    )

    // 收摊：设置改回去、关注项删掉、订阅退掉（自检不该给下一段留痕迹）
    await run(
      `window.opsCabin.updateSettings({ notifyOnPortChange: true, quietHours: { enabled: false, start: ${JSON.stringify(quietStart)}, end: ${JSON.stringify(quietEnd)} } })`
    )
    await run(
      `Promise.all(${JSON.stringify(probePorts)}.map((port) => window.opsCabin.removeWatch(port)))`
    )
    await run(`window.opsCabin.unsubscribePorts()`)
    await probeB.close()
    await probeC.close()
    smoke('notify-probe', {
      ports: probePorts,
      quiet: { start: quietStart, end: quietEnd },
      quietControls,
      badgesAfterUpdate,
      at: Date.now()
    })

    smoke('done', { at: Date.now() })
  } catch (error) {
    smoke('smoke-error', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    for (const server of servers) {
      try {
        server.close()
      } catch {
        /* 忽略 */
      }
    }
    if (SMOKE_EXIT) {
      // 用 app.quit 而不是 win.close —— 后者会被「关窗 = 隐藏」的逻辑拦下，进程不退出
      setTimeout(() => app.quit(), 500)
    }
  }
}
