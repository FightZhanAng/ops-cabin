// M8 打包产物的验证：检查 Release 要件 + 启动打包后的应用（win-unpacked）跑一遍界面。
//
// 覆盖：setup / portable / latest.yml / blockmap 齐备；打包版可启动、React 渲染、
//       设置页「更新」分组就位（打包形态下 updater 可用而非「开发模式」）。
//
// 用法：先 `pnpm dist`，再 node scripts/e2e-portable.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 19237
/** 版本号跟着 package.json 走：以后升版本不需要改这个脚本 */
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const releaseDir = join(root, 'release')
const exe = join(releaseDir, 'win-unpacked', '运维舱.exe')
const userDataDir = join(tmpdir(), 'ops-cabin-portable-e2e-userdata')

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

async function waitForReadyPage(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets()
    const page = targets?.find((t) => t.type === 'page' && t.title)
    if (page) return page
    await wait(500)
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
      throw new Error(`evaluate 超时（${timeoutMs}ms）`)
    })
  ])
  if (race.exceptionDetails) {
    throw new Error(race.exceptionDetails.exception?.description ?? race.exceptionDetails.text)
  }
  return race.result?.value
}

async function waitForDom(cdp, expression, timeoutMs = 15000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await evaluate(cdp, expression)) === true) return true
    await wait(stepMs)
  }
  return false
}

/** 程序化点击（打包版验证不追求真实鼠标序列） */
function clickExpr(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    return true
  })()`
}

/* ---------------- 主流程 ---------------- */

console.log('== 检查 Release 要件 ==')
const setup = join(releaseDir, `ops-cabin-${appVersion}-setup.exe`)
const portable = join(releaseDir, `ops-cabin-${appVersion}-portable.exe`)
const latestYml = join(releaseDir, 'latest.yml')
check('setup.exe 存在且体积合理', existsSync(setup) && statSync(setup).size > 50 * 1024 * 1024, `${Math.round(statSync(setup).size / 1024 / 1024)}MB`)
check('portable.exe 存在且体积合理', existsSync(portable) && statSync(portable).size > 50 * 1024 * 1024, `${Math.round(statSync(portable).size / 1024 / 1024)}MB`)
check('latest.yml 存在（自动更新必需）', existsSync(latestYml))
const blockmaps = existsSync(releaseDir)
  ? spawnSync(process.execPath, ['-e', `const fs=require('fs');console.log(fs.readdirSync(${JSON.stringify(releaseDir)}).filter(f=>f.endsWith('.blockmap')).join(','))`], { encoding: 'utf8' }).stdout.trim()
  : ''
check('blockmap 存在（差量更新必需）', blockmaps.length > 0, blockmaps)
check('win-unpacked 可执行文件存在', existsSync(exe), exe)

console.log('== 启动打包版应用 ==')
rmSync(userDataDir, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })
currentChild = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
  stdio: 'ignore'
})

const page = await waitForReadyPage()
if (!page) {
  check('打包版应用可启动', false, '未暴露 CDP 页面')
} else {
  check('打包版应用可启动', true, `title=${page.title}`)
  const cdp = await connect(page.webSocketDebuggerUrl)
  check(
    'React 渲染就绪',
    await waitForDom(cdp, `document.querySelectorAll('nav button').length >= 4`, 15000)
  )
  const info = JSON.parse(
    await evaluate(cdp, `window.opsCabin.getAppInfo().then((i) => JSON.stringify(i))`, true)
  )
  check('版本信息正确', info.version === appVersion, `v${info.version} · Electron ${info.electron}`)

  await evaluate(cdp, clickExpr('[data-testid="nav-settings"]'))
  check(
    '设置页更新分组就位',
    await waitForDom(cdp, `!!document.querySelector('[data-testid="update-section"]')`, 8000)
  )
  const updateText = await evaluate(
    cdp,
    `document.querySelector('[data-testid="update-section"]')?.textContent ?? ''`
  )
  check('打包形态下 updater 可用（非开发模式提示）', !updateText.includes('开发模式'), updateText.replace(/\s+/g, ' ').slice(0, 70))
  check(
    '检查更新按钮可用',
    (await evaluate(cdp, `document.querySelector('[data-testid="update-check"]')?.disabled === false`)) === true
  )

  // 退出（走应用自己的退出出口）
  try {
    await evaluate(cdp, 'window.opsCabin.quit()', true, 5000)
  } catch {
    /* 退出途中 */
  }
  let exited = false
  for (let i = 0; i < 20; i++) {
    await wait(400)
    if (!(await listTargets())) {
      exited = true
      break
    }
  }
  check('打包版可正常退出', exited)
  cdp.close()
}

console.log('')
console.log(failures === 0 ? '✅ E2E-PORTABLE 全部通过' : `❌ E2E-PORTABLE 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
