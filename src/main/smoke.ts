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

  const servers: Server[] = []
  try {
    // 自检自己开一个端口：端口页必须能把它列出来
    const selfPort = await new Promise<number>((resolve) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
      servers.push(server)
    })
    smoke('self-port', { port: selfPort })

    /* ---- 总览 ---- */
    await wait(2500)
    smoke(
      'view-overview',
      await run(`({
         volumes: document.querySelectorAll('[data-testid="overview-volume"]').length,
         cpuText: document.querySelector('[data-testid="metric-cpu"]')?.textContent ?? null,
         memText: document.querySelector('[data-testid="metric-mem"]')?.textContent ?? null,
         alerts: document.querySelectorAll('[data-testid="alert-item"]').length,
         text: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 160)
       })`)
    )
    await capture('screen-overview')

    /* ---- 磁盘页：真实扫描（safe + devCaches） ---- */
    await nav('disk')
    await wait(900)
    await press('[data-testid="scan-start"]')
    let diskRows = 0
    for (let i = 0; i < 80; i++) {
      await wait(500)
      diskRows = Number(await run(`document.querySelectorAll('[data-testid="result-row"]').length`))
      if (diskRows > 0) break
    }
    smoke(
      'view-disk',
      await run(`({
         rows: document.querySelectorAll('[data-testid="result-row"]').length,
         summary: document.querySelector('[data-testid="selection-summary"]')?.textContent ?? null,
         firstRow: document.querySelector('[data-testid="result-row"]')?.innerText.replace(/\\n+/g, ' | ') ?? null
       })`)
    )
    await capture('screen-disk')

    /* ---- 端口页：必须包含自检自己开的端口 ---- */
    await nav('ports')
    // 离开总览后监控器停采，端口页首屏要现采一次；冷启动的进程信息查询可能超过 2 秒
    await wait(5000)
    smoke(
      'view-ports',
      await run(`({
         rows: document.querySelectorAll('[data-testid="port-row"]').length,
         sawSelfPort: !!document.querySelector('[data-testid="port-row"][data-port="${selfPort}"]'),
         watchCards: document.querySelectorAll('[data-testid="watch-card"]').length,
         timeline: !!document.querySelector('[data-testid="change-timeline"]')
       })`)
    )
    await capture('screen-ports')

    /* ---- 设置页 ---- */
    await nav('settings')
    await wait(900)
    smoke(
      'view-settings',
      await run(`({
         themePicker: !!document.querySelector('[data-testid="theme-picker"]'),
         notifySwitch: !!document.querySelector('[data-testid="notify-switch"]'),
         whitelist: !!document.querySelector('[data-testid="whitelist-editor"]'),
         scanPlan: !!document.querySelector('[data-testid="scan-plan-editor"]'),
         dangerZone: !!document.querySelector('[data-testid="danger-zone"]'),
         text: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 120)
       })`)
    )
    await capture('screen-settings')

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
