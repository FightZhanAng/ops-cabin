// M6 总览页的端到端验证（CDP 驱动 + 真实服务 + 真实鼠标点击）。
//
// 覆盖：一屏渲染（分区条/资源/关注端口/提醒流）/ 指标推送与走势线 /
//       关注端口卡片实时状态 / 提醒流条目 / 面板导航 / 重进页面重订阅。
//
// 用法：node scripts/e2e-overview.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 19233
const PORT_A = 51733
const userDataDir = join(tmpdir(), 'ops-cabin-overview-e2e-userdata')
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

let failures = 0
let currentChild = null
let serverA = null
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

function stopServers() {
  try {
    serverA?.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  serverA = null
}

function shutdown(code) {
  closeSockets()
  stopServers()
  try {
    currentChild?.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  setTimeout(() => process.exit(code), 220)
}

process.on('exit', () => {
  closeSockets()
  stopServers()
})
process.on('uncaughtException', (error) => {
  console.error(error)
  shutdown(1)
})

function startServer(port) {
  return spawn(
    process.execPath,
    [
      '-e',
      `require('http').createServer((req, res) => res.end('ok')).listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`
    ],
    { stdio: 'ignore' }
  )
}

/* ---------------- CDP 工具 ---------------- */

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

/** 真实鼠标点击：先滚动落定、再取坐标（配合页内「禁动画」注入使用） */
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
    { cwd: root, stdio: 'ignore', env: { ...process.env, OPS_CABIN_SMOKE: '1' } }
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
  const invoke = (code, timeout = 60000) => evaluate(cdp, code, true, timeout)

  /* ---------- 准备：关注一个真实服务（让总览有可展示的数据） ---------- */
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
  serverA = startServer(PORT_A)
  await wait(1200)
  await invoke(`window.opsCabin.addWatch({ port: ${PORT_A}, label: '总览测试服务' }).then((w) => JSON.stringify(w))`)
  await wait(5500) // 让 occupy 事件落盘（基线建立 → 观察到占用）

  /* ---------- A. 重进总览：渲染一屏 ---------- */
  console.log('== A. 总览渲染 ==')
  check('切到磁盘页', await clickAt(cdp, '[data-testid="nav-disk"]')) // 先离开总览（重新挂载时读到完整数据）
  await wait(600)
  check('切回总览', await clickAt(cdp, '[data-testid="nav-overview"]'))
  await waitForDom(cdp, `!!document.querySelector('[data-testid="overview-view"]')`, 8000)
  await wait(1000)

  check('总览页渲染', (await evaluate(cdp, `!!document.querySelector('[data-testid="overview-view"]')`)) === true)
  check(
    '分区条有数据',
    await waitForDom(cdp, `document.querySelectorAll('[data-testid="overview-volume"]').length >= 1`, 8000)
  )
  check(
    '分区条展示剩余空间',
    (await evaluate(
      cdp,
      `(document.querySelector('[data-testid="overview-volume"]')?.textContent ?? '').includes('剩余')`
    )) === true
  )
  check(
    '关注端口卡片出现（占用中）',
    await waitForDom(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_A}"]')?.dataset.occupied === 'true'`,
      10000
    )
  )
  check(
    '卡片显示自定义名称',
    (await evaluate(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_A}"]')?.textContent?.includes('总览测试服务')`
    )) === true
  )
  check(
    '提醒流出现端口变化',
    await waitForDom(cdp, `document.querySelectorAll('[data-testid="alert-item"]').length >= 1`, 6000)
  )

  /* ---------- B. 指标推送与走势线 ---------- */
  console.log('== B. 资源指标 ==')
  await wait(4500) // 攒几个采样点
  const cpuText = await evaluate(cdp, `document.querySelector('[data-testid="metric-cpu"]')?.textContent ?? ''`)
  const memText = await evaluate(cdp, `document.querySelector('[data-testid="metric-mem"]')?.textContent ?? ''`)
  check('CPU 读数出现', /\d+(\.\d+)?%/.test(cpuText), cpuText.replace(/\s+/g, ' ').slice(0, 40))
  check('内存读数出现', /\d+(\.\d+)?%/.test(memText), memText.replace(/\s+/g, ' ').slice(0, 40))
  const cpuPoints = await evaluate(
    cdp,
    `(document.querySelector('[data-testid="metric-cpu"] polyline')?.getAttribute('points') ?? '').split(' ').filter(Boolean).length`
  )
  check('CPU 走势线有数据点（持续推送）', cpuPoints >= 3, `points=${cpuPoints}`)
  const memDetail = await evaluate(cdp, `document.querySelector('[data-testid="metric-mem"]')?.textContent ?? ''`)
  check('内存展示已用/总量', memDetail.includes('/'), memDetail.replace(/\s+/g, ' ').slice(0, 60))

  /* ---------- C. 面板导航 ---------- */
  console.log('== C. 面板导航 ==')
  check('点击分区条', await clickAt(cdp, '[data-testid="partition-bars"]'))
  check(
    '跳转到磁盘页',
    await waitForDom(cdp, `!!document.querySelector('[data-testid="scan-start"]')`, 6000)
  )
  await clickAt(cdp, '[data-testid="nav-overview"]')
  await waitForDom(cdp, `!!document.querySelector('[data-testid="overview-view"]')`, 6000)
  await wait(800)
  check('点击关注端口面板', await clickAt(cdp, '[data-testid="overview-watch"]'))
  check(
    '跳转到端口页',
    await waitForDom(cdp, `!!document.querySelector('[data-testid="watch-grid"]')`, 6000)
  )

  /* ---------- D. 重进总览：数据仍在（重订阅） ---------- */
  console.log('== D. 返回总览 ==')
  await clickAt(cdp, '[data-testid="nav-overview"]')
  check(
    '返回后总览数据完整',
    await waitForDom(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_A}"]') !== null && document.querySelectorAll('[data-testid="overview-volume"]').length >= 1`,
      10000
    )
  )

  // 清理：移除测试关注项
  await invoke(`window.opsCabin.removeWatch(${PORT_A}).then((w) => JSON.stringify(w))`)

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

console.log('')
console.log(failures === 0 ? '✅ E2E-OVERVIEW 全部通过' : `❌ E2E-OVERVIEW 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
