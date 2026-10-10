// M8 更新流程的端到端验证（OPS_CABIN_FAKE_UPDATE 注入假版本，不联网驱动全流程）。
//
// 覆盖：设置页「更新」分组渲染 / 检查更新 → 发现新版本 / 下载进度 → 已就绪 /
//       发布页入口 / 每天自动检查开关落盘。
//
// 用法：node scripts/e2e-update.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 19235
const FAKE_VERSION = '9.9.9'
/** 当前版本号跟着 package.json 走：以后升版本不需要改这个脚本 */
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const userDataDir = join(tmpdir(), 'ops-cabin-update-e2e-userdata')
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const settingsFile = join(userDataDir, 'settings.json')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

let failures = 0
let currentChild = null
const sockets = new Set()

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  （${detail}）` : ''}`)
  if (!ok) failures++
}

function closeSockets() {
  for (const ws of sockets) {
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

function shutdown(code) {
  closeSockets()
  try {
    currentChild?.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  setTimeout(() => process.exit(code), 220)
}

process.on('exit', closeSockets)
process.on('uncaughtException', (error) => {
  console.error(error)
  shutdown(1)
})

async function listTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`)
    return await res.json()
  } catch {
    return null
  }
}

async function waitForReadyPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets()
    const page = targets?.find((t) => t.type === 'page' && t.title)
    if (page) return page
    await wait(400)
  }
  return null
}

async function connect(url) {
  const ws = new WebSocket(url)
  sockets.add(ws)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  let counter = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    }
  })
  ws.addEventListener('close', () => {
    sockets.delete(ws)
    for (const entry of pending.values()) entry.reject(new Error('CDP 连接已关闭'))
    pending.clear()
  })
  return {
    send: (method, params) =>
      new Promise((resolve, reject) => {
        const id = counter++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      }),
    close: () => ws.close()
  }
}

async function evaluate(cdp, expression, awaitPromise = false, timeoutMs = 60000) {
  const race = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }),
    wait(timeoutMs).then(() => {
      throw new Error(`evaluate 超时（${timeoutMs}ms）：${expression.slice(0, 80)}`)
    })
  ])
  if (race.exceptionDetails) {
    throw new Error(race.exceptionDetails.exception?.description ?? race.exceptionDetails.text)
  }
  return race.result?.value
}

async function clickAt(cdp, selector) {
  const scrolled = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      return true
    })()`
  )
  if (scrolled !== true) return false
  await wait(80)
  const info = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`
  )
  if (info === 'null' || info === null) return false
  const { x, y } = JSON.parse(info)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return true
}

async function waitForDom(cdp, expression, timeoutMs = 15000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await evaluate(cdp, expression)) === true) return true
    await wait(stepMs)
  }
  return false
}

function launch() {
  currentChild = spawn(
    electronExe,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, OPS_CABIN_SMOKE: '1', OPS_CABIN_FAKE_UPDATE: FAKE_VERSION }
    }
  )
  return currentChild
}

async function quitApp(page, child) {
  try {
    const cdp = await connect(page.webSocketDebuggerUrl)
    await evaluate(cdp, 'window.opsCabin.quit()', true, 5000)
    cdp.close()
  } catch {
    /* 应用可能已在退出途中 */
  }
  for (let i = 0; i < 20; i++) {
    await wait(400)
    if (!(await listTargets())) return true
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  await wait(800)
  return !(await listTargets())
}

/* ---------------- 主流程 ---------------- */

console.log('== 构建 ==')
const build = spawnSync('pnpm build', { cwd: root, shell: true, encoding: 'utf8' })
if (build.status !== 0) {
  console.log(build.stdout ?? '')
  console.error(build.stderr ?? '')
  console.error('构建失败，中止')
  process.exit(1)
}

console.log('== 准备隔离环境 ==')
rmSync(userDataDir, { recursive: true, force: true })
rmSync(smokeDir, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })

const app = launch()
const page = await waitForReadyPage()
if (!page) {
  console.error('应用未能在限定时间内完成加载')
  shutdown(1)
} else {
  const cdp = await connect(page.webSocketDebuggerUrl)

  check('React 渲染就绪', await waitForDom(cdp, `document.querySelectorAll('nav button').length >= 4`, 15000))
  await evaluate(
    cdp,
    `(() => {
      const style = document.createElement('style')
      style.textContent =
        '*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }'
      document.head.appendChild(style)
      return 'ok'
    })()`
  )

  /* ---------- A. 更新分组渲染 ---------- */
  console.log('== A. 更新分组 ==')
  check('切到设置页', await clickAt(cdp, '[data-testid="nav-settings"]'))
  check('更新分组渲染', await waitForDom(cdp, `!!document.querySelector('[data-testid="update-section"]')`, 8000))
  const versionText = await evaluate(
    cdp,
    `document.querySelector('[data-testid="update-section"]')?.textContent ?? ''`
  )
  check(
    '显示当前版本',
    versionText.includes(appVersion),
    versionText.replace(/\s+/g, ' ').slice(0, 60)
  )
  check(
    '模拟模式说明',
    versionText.includes('模拟更新模式'),
    versionText.replace(/\s+/g, ' ').slice(0, 60)
  )
  check('检查按钮可用', (await evaluate(cdp, `document.querySelector('[data-testid="update-check"]')?.disabled === false`)) === true)
  check('发布页入口存在', (await evaluate(cdp, `!!document.querySelector('[data-testid="update-release-page"]')`)) === true)

  /* ---------- B. 检查 → 发现新版本 ---------- */
  console.log('== B. 检查更新 ==')
  check('点击检查更新', await clickAt(cdp, '[data-testid="update-check"]'))
  check(
    '发现新版本（出现下载按钮）',
    await waitForDom(
      cdp,
      `document.querySelector('[data-testid="update-download"]')?.textContent?.includes('${FAKE_VERSION}') === true`,
      6000
    )
  )

  /* ---------- C. 下载 → 已就绪 ---------- */
  console.log('== C. 下载 ==')
  check('点击下载', await clickAt(cdp, '[data-testid="update-download"]'))
  const sawProgress = await waitForDom(
    cdp,
    `(document.querySelector('[data-testid="update-message"]')?.textContent ?? '').includes('%')`,
    6000,
    150
  )
  check('下载过程中显示进度', sawProgress)
  check(
    '下载完成（出现重启并安装）',
    await waitForDom(cdp, `!!document.querySelector('[data-testid="update-install"]')`, 12000)
  )
  const doneText = await evaluate(
    cdp,
    `document.querySelector('[data-testid="update-message"]')?.textContent ?? ''`
  )
  check('就绪文案', doneText.includes('下载完成'), doneText.replace(/\s+/g, ' ').slice(0, 50))

  /* ---------- D. 自动检查开关 ---------- */
  console.log('== D. 自动检查开关 ==')
  check('关闭自动检查', await clickAt(cdp, '[data-testid="auto-update-switch"]'))
  await wait(400)
  check(
    '设置落盘 autoCheckUpdate=false',
    JSON.parse(readFileSync(settingsFile, 'utf8')).autoCheckUpdate === false
  )
  check('重新打开', await clickAt(cdp, '[data-testid="auto-update-switch"]'))
  await wait(400)
  check(
    '设置落盘 autoCheckUpdate=true',
    JSON.parse(readFileSync(settingsFile, 'utf8')).autoCheckUpdate === true
  )

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

console.log('')
console.log(failures === 0 ? '✅ E2E-UPDATE 全部通过' : `❌ E2E-UPDATE 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
