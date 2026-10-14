// M5 端口页的端到端验证（CDP 驱动 + 真实服务 + 真实鼠标点击）。
//
// 覆盖：页面渲染 / 表格实时刷新 / 星标关注 / 详情对话框 / 结束进程（含二次确认与 toast）/
//       kill 安全边界 / 变化时间线 / 添加关注对话框 / 移除关注 / 页面切换重订阅。
//
// 用法：node scripts/e2e-ports-m5.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/*
 * ELECTRON_RUN_AS_NODE 从宿主环境漏进来会让 electron.exe 退化成纯 Node ——
 * 没有 app、没有 BrowserWindow，主进程加载到 electron-updater 就炸
 * （报 `Cannot read properties of undefined (reading 'getVersion')`，
 * 栈底会看到 Node.js 的版本号而不是 Electron），表现为「应用未能在限定时间内完成加载」。
 * 这是宿主环境的事，不该要求每次调用都记得清 —— 与 e2e-smoke.mjs 同口径。
 */
delete process.env['ELECTRON_RUN_AS_NODE']
const PORT = 19228
const PORT_A = 51733
const PORT_B = 51734
const userDataDir = join(tmpdir(), 'ops-cabin-portsv-e2e-userdata')
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

/** 真实鼠标点击（radix 组件在 mousedown 激活，程序化 .click() 不可靠）。
 *  先 scrollIntoView 并等一拍布局落定，再取坐标 —— 长列表里目标可能在视口外，
 *  对话框的入场动画也会让坐标在取用的瞬间还在变化。 */
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

/** 等待某个 DOM 条件成立（轮询求值） */
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

  /* ---------- A. 页面渲染 ---------- */
  console.log('== A. 页面渲染 ==')
  // title 就绪不代表 React 已挂载：等导航按钮出现再操作
  check(
    'React 渲染就绪',
    await waitForDom(cdp, `document.querySelectorAll('nav button').length >= 4`, 15000)
  )
  // 禁用过渡与动画：radix 的入场动画会让「取坐标 → 点击」之间元素仍在移动，
  // 导致偶发点歪（与 Playwright 自动化的做法一致）
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
  await evaluate(
    cdp,
    // 按 testid 导航：侧栏按钮里现在还会渲染徽标文本（M14 起），按 textContent 精确匹配会落空
    `document.querySelector('[data-testid="nav-ports"]')?.click(); 'ok'`
  )
  await waitForDom(cdp, `!!document.querySelector('[data-testid="watch-grid"]')`, 8000)
  await wait(500)
  check('卡片阵渲染', (await evaluate(cdp, `!!document.querySelector('[data-testid="watch-grid"]')`)) === true)
  check('端口表渲染', (await evaluate(cdp, `!!document.querySelector('[data-testid="port-table"]')`)) === true)
  check(
    '变化时间线渲染',
    (await evaluate(cdp, `!!document.querySelector('[data-testid="change-timeline"]')`)) === true
  )
  check(
    '表格有端口数据',
    await waitForDom(cdp, `document.querySelectorAll('[data-testid="port-row"]').length > 10`, 12000)
  )

  /* ---------- B. 真实服务出现在表格 ---------- */
  console.log('== B. 真实服务刷新到表格 ==')
  serverA = startServer(PORT_A)
  check(
    '新服务 2s 内出现在表格',
    await waitForDom(
      cdp,
      `!!document.querySelector('[data-testid="port-row"][data-port="${PORT_A}"]')`,
      10000
    ),
    `port=${PORT_A}`
  )
  check(
    '表格行显示进程名',
    (await evaluate(
      cdp,
      `document.querySelector('[data-testid="port-row"][data-port="${PORT_A}"]')?.textContent?.includes('node')`
    )) === true
  )

  /* ---------- C. 星标关注 → 卡片阵 ---------- */
  console.log('== C. 星标关注 ==')
  check(
    '点击行内星标',
    await clickAt(cdp, `[data-testid="port-row"][data-port="${PORT_A}"] [data-testid="port-watch-toggle"]`)
  )
  check(
    '卡片阵出现该端口（占用中）',
    await waitForDom(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_A}"]')?.dataset.occupied === 'true'`,
      8000
    )
  )
  check(
    '卡片显示进程名',
    (await evaluate(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_A}"]')?.textContent?.includes('node')`
    )) === true
  )

  /* ---------- D. 详情对话框 ---------- */
  console.log('== D. 进程详情 ==')
  check(
    '点击表格行',
    await clickAt(cdp, `[data-testid="port-row"][data-port="${PORT_A}"] td:first-child`)
  )
  check(
    '详情对话框出现',
    await waitForDom(cdp, `!!document.querySelector('[data-testid="proc-dialog"]')`, 6000)
  )
  const dialogText =
    (await evaluate(cdp, `document.querySelector('[data-testid="proc-dialog"]')?.textContent ?? ''`)) ?? ''
  check('详情含 PID 与命令行区', dialogText.includes(String(serverA.pid)) && dialogText.includes('PID'), `pid=${serverA.pid}`)
  check('详情含结束进程按钮', dialogText.includes('结束进程'))

  /* ---------- E. 结束进程（二次确认） ---------- */
  console.log('== E. 结束进程 ==')
  check('点击结束进程', await clickAt(cdp, '[data-testid="kill-open"]'))
  check(
    '出现二次确认',
    await waitForDom(
      cdp,
      `[...document.querySelectorAll('[role="alertdialog"]')].some((d) => d.textContent?.includes('未保存的数据'))`,
      5000
    )
  )
  check('点击确认', await clickAt(cdp, '[data-testid="kill-confirm"]'))

  // 服务进程应被结束
  let serverDead = false
  for (let i = 0; i < 15; i++) {
    await wait(300)
    if (serverA.exitCode !== null || serverA.signalCode !== null) {
      serverDead = true
      break
    }
  }
  check('服务进程已被结束', serverDead, `exit=${serverA.exitCode}`)
  check(
    '出现成功 toast',
    await waitForDom(
      cdp,
      `[...document.querySelectorAll('[data-sonner-toast]')].some((t) => t.textContent?.includes('已结束'))`,
      5000
    )
  )
  check(
    '表格行随后消失（快照刷新）',
    await waitForDom(
      cdp,
      `!document.querySelector('[data-testid="port-row"][data-port="${PORT_A}"]')`,
      10000
    )
  )
  check(
    '卡片状态转为空闲',
    await waitForDom(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_A}"]')?.dataset.occupied === 'false'`,
      10000
    )
  )

  /* ---------- F. 变化时间线 ---------- */
  console.log('== F. 变化时间线 ==')
  const releaseShown = await waitForDom(
    cdp,
    `[...document.querySelectorAll('[data-testid="change-entry"]')].some((e) => e.textContent?.includes('${PORT_A}') && e.textContent?.includes('已释放'))`,
    12000
  )
  if (!releaseShown) {
    const events = await invoke(
      'window.opsCabin.listPortEvents().then((e) => JSON.stringify(e.slice(0, 5)))'
    )
    const dom = await evaluate(
      cdp,
      `JSON.stringify([...document.querySelectorAll('[data-testid="change-entry"]')].map((e) => e.textContent))`
    )
    const watch = await invoke('window.opsCabin.getWatchlist().then((w) => JSON.stringify(w))')
    console.log(`   （诊断）主进程事件: ${events}`)
    console.log(`   （诊断）时间线DOM: ${dom}`)
    console.log(`   （诊断）关注清单: ${watch}`)
  }
  check('时间线记录了释放事件', releaseShown)

  /* ---------- G. kill 安全边界 ---------- */
  console.log('== G. kill 安全边界 ==')
  const forgedKill = JSON.parse(
    await invoke(`window.opsCabin.runKill(999999).then((r) => JSON.stringify(r))`)
  )
  check('不在快照里的进程被拒绝', forgedKill.ok === false, forgedKill.error)
  const systemKill = JSON.parse(
    await invoke(`window.opsCabin.runKill(4).then((r) => JSON.stringify(r))`)
  )
  check('系统进程（PID 4）被拒绝', systemKill.ok === false, systemKill.error)

  /* ---------- H. 添加关注对话框 ---------- */
  console.log('== H. 添加关注 ==')
  check('点击添加卡片', await clickAt(cdp, '[data-testid="watch-add"]'))
  check(
    '对话框出现',
    await waitForDom(cdp, `!!document.querySelector('[data-testid="add-watch-dialog"]')`, 5000)
  )
  check('聚焦端口输入框', await clickAt(cdp, '[data-testid="watch-port-input"]'))
  await cdp.send('Input.insertText', { text: String(PORT_B) })
  check('聚焦名称输入框', await clickAt(cdp, '[data-testid="watch-label-input"]'))
  await cdp.send('Input.insertText', { text: '预留端口' })
  check('提交关注', await clickAt(cdp, '[data-testid="watch-submit"]'))
  check(
    '新卡片出现（空闲态）',
    await waitForDom(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_B}"]')?.dataset.occupied === 'false'`,
      8000
    )
  )
  check(
    '新卡片带自定义名称',
    (await evaluate(
      cdp,
      `document.querySelector('[data-testid="watch-card"][data-port="${PORT_B}"]')?.textContent?.includes('预留端口')`
    )) === true
  )

  /* ---------- I. 移除关注 ---------- */
  console.log('== I. 移除关注 ==')
  check(
    '点击卡片移除按钮',
    await clickAt(cdp, `[data-testid="watch-card"][data-port="${PORT_B}"] [data-testid="watch-remove"]`)
  )
  check(
    '卡片消失',
    await waitForDom(
      cdp,
      `!document.querySelector('[data-testid="watch-card"][data-port="${PORT_B}"]')`,
      6000
    )
  )

  /* ---------- J. 页面切换重订阅 ---------- */
  console.log('== J. 页面切换重订阅 ==')
  await evaluate(
    cdp,
    `document.querySelector('[data-testid="nav-disk"]')?.click(); 'ok'`
  )
  await wait(600)
  await evaluate(
    cdp,
    `document.querySelector('[data-testid="nav-ports"]')?.click(); 'ok'`
  )
  check(
    '切回后表格仍有数据（重订阅生效）',
    await waitForDom(cdp, `document.querySelectorAll('[data-testid="port-row"]').length > 10`, 10000)
  )

  // 清理：移除测试关注项
  await invoke(`window.opsCabin.removeWatch(${PORT_A}).then((w) => JSON.stringify(w))`)

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

console.log('')
console.log(failures === 0 ? '✅ E2E-PORTS-M5 全部通过' : `❌ E2E-PORTS-M5 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
