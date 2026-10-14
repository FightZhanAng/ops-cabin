// M7 设置页的端到端验证（CDP 驱动 + 真实鼠标点击）。
//
// 覆盖：分组渲染 / 主题即时生效（nativeTheme → 媒体查询）/ 通知开关 /
//       白名单增删 / 清理计划落盘与调度器触发（冒烟探针）/ 危险区（清空记录、重置设置）。
//
// 用法：node scripts/e2e-settings.mjs
// 说明：计划触发测试会真实执行一次系统扫描并弹一条系统通知。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
const PORT = 19234
const PORT_A = 51733
const userDataDir = join(tmpdir(), 'ops-cabin-settings-e2e-userdata')
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const settingsFile = join(userDataDir, 'settings.json')
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

function readSettingsFromDisk() {
  return JSON.parse(readFileSync(settingsFile, 'utf8'))
}

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
  const invoke = (code, timeout = 90000) => evaluate(cdp, code, true, timeout)

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

  /* ---------- A. 设置页渲染 ---------- */
  console.log('== A. 设置页渲染 ==')
  check('切到设置页', await clickAt(cdp, '[data-testid="nav-settings"]'))
  check('设置页渲染', await waitForDom(cdp, `!!document.querySelector('[data-testid="settings-view"]')`, 8000))
  check('主题选择器', (await evaluate(cdp, `!!document.querySelector('[data-testid="theme-picker"]')`)) === true)
  check('通知开关', (await evaluate(cdp, `!!document.querySelector('[data-testid="notify-switch"]')`)) === true)
  check('白名单编辑器', (await evaluate(cdp, `!!document.querySelector('[data-testid="whitelist-editor"]')`)) === true)
  check('清理计划编辑器', (await evaluate(cdp, `!!document.querySelector('[data-testid="scan-plan-editor"]')`)) === true)
  check('危险区', (await evaluate(cdp, `!!document.querySelector('[data-testid="danger-zone"]')`)) === true)
  check('关于：数据目录入口', (await evaluate(cdp, `!!document.querySelector('[data-testid="open-data-dir"]')`)) === true)

  /* ---------- B. 主题即时生效 ---------- */
  console.log('== B. 主题 ==')
  check('选择深色', await clickAt(cdp, '[data-testid="theme-dark"]'))
  await wait(600)
  check('设置落盘 theme=dark', readSettingsFromDisk().theme === 'dark', readSettingsFromDisk().theme)
  check(
    '渲染层媒体查询变深色',
    (await evaluate(cdp, `matchMedia('(prefers-color-scheme: dark)').matches`)) === true
  )
  check('切回跟随系统', await clickAt(cdp, '[data-testid="theme-system"]'))
  await wait(400)
  check('设置落盘 theme=system', readSettingsFromDisk().theme === 'system')

  /* ---------- C. 通知开关 ---------- */
  console.log('== C. 通知开关 ==')
  check('关闭通知', await clickAt(cdp, '[data-testid="notify-switch"]'))
  await wait(400)
  check('设置落盘 notify=false', readSettingsFromDisk().notifyOnPortChange === false)
  check('重新打开', await clickAt(cdp, '[data-testid="notify-switch"]'))
  await wait(400)
  check('设置落盘 notify=true', readSettingsFromDisk().notifyOnPortChange === true)

  /* ---------- D. 白名单增删 ---------- */
  console.log('== D. 白名单 ==')
  const fakeDir = 'C:\\Users\\Public\\ops-cabin-e2e-keep'
  await invoke(
    `window.opsCabin.updateSettings({ whitelist: [${JSON.stringify(fakeDir)}] }).then((s) => JSON.stringify(s))`
  )
  // 切走再回到设置页（重新读取 settings）
  await clickAt(cdp, '[data-testid="nav-disk"]')
  await wait(500)
  await clickAt(cdp, '[data-testid="nav-settings"]')
  check(
    '白名单项显示',
    await waitForDom(cdp, `document.querySelectorAll('[data-testid="whitelist-item"]').length === 1`, 6000)
  )
  check('点击移除', await clickAt(cdp, '[data-testid="whitelist-remove"]'))
  await wait(400)
  check('白名单已清空（落盘）', readSettingsFromDisk().whitelist.length === 0)

  /* ---------- E. 清理计划落盘 ---------- */
  console.log('== E. 清理计划 ==')
  check('选择「每天」', await clickAt(cdp, '[data-testid="plan-daily"]'))
  await wait(400)
  check('设置落盘 mode=daily', readSettingsFromDisk().scanPlan.mode === 'daily')

  // 设一个刚过去的时刻（保证到点）；用 React 原生 setter 写受控输入
  const now = new Date()
  now.setMinutes(now.getMinutes() - 1)
  const pastTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector('[data-testid="plan-time"]')
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '${pastTime}')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
      return 'ok'
    })()`
  )
  await wait(500)
  check('设置落盘 time', readSettingsFromDisk().scanPlan.time === pastTime, `expect=${pastTime}`)

  /* ---------- F. 调度器触发（冒烟探针） ---------- */
  console.log('== F. 计划触发 ==')
  const fired = await invoke('window.opsCabin.checkScanPlanNow()')
  check('触发检查返回 true', fired === true, `fired=${fired}`)
  const smokeFile = join(smokeDir, 'scheduled-scan.json')
  const scanDeadline = Date.now() + 45000
  while (Date.now() < scanDeadline && !existsSync(smokeFile)) {
    await wait(1000)
  }
  check('计划扫描完成（冒烟探针写出）', existsSync(smokeFile))
  if (existsSync(smokeFile)) {
    const summary = JSON.parse(readFileSync(smokeFile, 'utf8'))
    check(
      '扫描摘要有效',
      typeof summary.items === 'number' && typeof summary.bytes === 'number' && summary.durationMs > 0,
      `items=${summary.items} bytes=${summary.bytes}`
    )
  }
  const firedAgain = await invoke('window.opsCabin.checkScanPlanNow()')
  check('当天不重复触发', firedAgain === false)

  /* ---------- G. 危险区：清空变化记录 ---------- */
  console.log('== G. 清空变化记录 ==')
  // 基线语义（ports/watch.ts #pendingBaseline）：刚关注时已在监听的端口不报变化 ——
  // 先关注（此刻端口空闲）→ 越过一个采样周期让基线成立 → 再起服务，才能看到干净的 occupy。
  await invoke(`window.opsCabin.addWatch({ port: ${PORT_A}, label: '设置页测试' }).then((w) => JSON.stringify(w))`)
  await wait(6500) // 设置页没有端口订阅，后台 5s 一拍：这里越过首拍（建立基线）
  serverA = startServer(PORT_A)
  // 轮询等待变化事件出现（含采集耗时）
  let eventsBefore = []
  const gDeadline = Date.now() + 20000
  while (Date.now() < gDeadline) {
    await wait(1500)
    eventsBefore = JSON.parse(
      await invoke('window.opsCabin.listPortEvents().then((e) => JSON.stringify(e))')
    )
    if (eventsBefore.length > 0) break
  }
  check('已有变化记录', eventsBefore.length >= 1, `count=${eventsBefore.length}`)

  check('点「清空」', await clickAt(cdp, '[data-testid="danger-clear-events"]'))
  check('出现确认框', await waitForDom(cdp, `!!document.querySelector('[data-testid="danger-confirm"]')`, 5000))
  check('确认执行', await clickAt(cdp, '[data-testid="danger-confirm-btn"]'))
  await wait(600)
  const eventsAfter = JSON.parse(
    await invoke('window.opsCabin.listPortEvents().then((e) => JSON.stringify(e))')
  )
  check('变化记录已清空', eventsAfter.length === 0, `count=${eventsAfter.length}`)

  /* ---------- H. 危险区：重置全部设置 ---------- */
  console.log('== H. 重置设置 ==')
  await invoke(
    `window.opsCabin.updateSettings({ theme: 'dark', notifyOnPortChange: false, whitelist: ['C:\\\\tmp'] }).then((s) => JSON.stringify(s))`
  )
  const boundsBefore = readSettingsFromDisk().windowBounds
  await wait(4800) // 等 G 段的成功 toast 消散 —— 它悬浮在危险区按钮上方会挡住真实点击
  check('点「重置」', await clickAt(cdp, '[data-testid="danger-reset"]'))
  check('出现确认框', await waitForDom(cdp, `!!document.querySelector('[data-testid="danger-confirm"]')`, 5000))
  check('确认重置', await clickAt(cdp, '[data-testid="danger-confirm-btn"]'))
  await wait(700)
  const after = readSettingsFromDisk()
  check(
    '设置已恢复默认',
    after.theme === 'system' &&
      after.notifyOnPortChange === true &&
      after.whitelist.length === 0 &&
      after.scanPlan.mode === 'manual',
    JSON.stringify({ theme: after.theme, notify: after.notifyOnPortChange, plan: after.scanPlan.mode })
  )
  check(
    '窗口位置保持原值（重置前 = 重置后）',
    JSON.stringify(after.windowBounds) === JSON.stringify(boundsBefore)
  )

  // 清理测试关注项
  await invoke(`window.opsCabin.removeWatch(${PORT_A}).then((w) => JSON.stringify(w))`)

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

console.log('')
console.log(failures === 0 ? '✅ E2E-SETTINGS 全部通过' : `❌ E2E-SETTINGS 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
