// M1 主进程地基的端到端验证（CDP + PowerShell Win32，跑真实窗口）。
//
// 覆盖：损坏设置回退 / 设置原子写盘 / 窗口移动 → 关窗保存 → 重启恢复 /
//       关窗隐藏不退出 / 托盘图标非空 / app:quit 出口。
//
// 用法：node scripts/e2e-check.mjs
// 说明：会真开窗口、移动它、再关掉；使用隔离的 user-data-dir，不碰真实用户数据。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const PORT = 19224
const userDataDir = join(tmpdir(), 'ops-cabin-e2e-userdata')
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
  // 给 undici/ws 一点收尾时间，避免进程退出瞬间的 libuv 断言
  setTimeout(() => process.exit(code), 220)
}

process.on('exit', closeSockets)
process.on('uncaughtException', (error) => {
  console.error(error)
  shutdown(1)
})

/* ---------------- CDP 工具 ---------------- */

async function listTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`)
    return await res.json()
  } catch {
    return null
  }
}

/** 等到出现「标题已就绪」的页面 —— 光有 target 不代表文档已加载完 */
async function waitForReadyPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets()
    // 文档解析完成前，CDP 报的标题是文件名（index.html）——等真正的 <title> 生效
    const page = targets?.find((t) => t.type === 'page' && t.title && t.title !== 'index.html')
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

async function evaluate(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  }
  return r.result?.value
}

async function readJsonWhenReady(file, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      lastError = error
      await wait(300)
    }
  }
  throw new Error(`等待文件超时：${file}（${lastError?.message ?? '未知'}）`)
}

/* ---------------- Windows 窗口移动（Win32 API，等价于人工拖窗口） ---------------- */

function moveWindowBy(pid, dx, dy) {
  const ps = [
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Win32Api {',
    '  [StructLayout(LayoutKind.Sequential)]',
    '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  [DllImport("user32.dll")]',
    '  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    '  [DllImport("user32.dll")]',
    '  public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);',
    '}',
    "'@",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if (-not $p) { Write-Output 'NO_PROCESS'; exit 2 }",
    '$h = $p.MainWindowHandle',
    'if ($h -eq [IntPtr]::Zero) {',
    "  Write-Output 'NO_WINDOW'",
    "  Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  pid=' + $_.Id + ' title=[' + $_.MainWindowTitle + ']') }",
    '  exit 2',
    '}',
    '$r = New-Object Win32Api+RECT',
    'if (-not [Win32Api]::GetWindowRect($h, [ref]$r)) { Write-Output "RECT_FAIL"; exit 2 }',
    `$ok = [Win32Api]::MoveWindow($h, $r.Left + ${dx}, $r.Top + ${dy}, $r.Right - $r.Left, $r.Bottom - $r.Top, $true)`,
    "if ($ok) { Write-Output ('MOVED ' + $r.Left + ',' + $r.Top) } else { Write-Output 'MOVE_FAIL'; exit 2 }"
  ].join('\n')
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8' }
  )
  return (r.stdout ?? '').trim()
}

/* ---------------- 应用启动 / 退出 ---------------- */

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
    await evaluate(cdp, 'window.opsCabin.quit()', true)
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
// 故意写坏设置文件：应用必须回退默认值继续启动，并留档一份现场副本
writeFileSync(settingsFile, '{ 这不是合法的 JSON', 'utf8')

console.log('== 第一轮：启动 / 损坏回退 / 设置落盘 / 关窗隐藏 ==')
let app1 = launch()
const page1 = await waitForReadyPage()
if (!page1) {
  console.error('应用未能在限定时间内完成加载')
  shutdown(1)
} else {
  check('窗口加载（标题正确）', page1.title === '运维舱', `title=${page1.title}`)
  check('损坏设置被留档为 .bad', existsSync(`${settingsFile}.bad`))

  const cdp1 = await connect(page1.webSocketDebuggerUrl)
  const s1 = JSON.parse(
    await evaluate(cdp1, 'window.opsCabin.getSettings().then((s) => JSON.stringify(s))', true)
  )
  check(
    '启动回退默认值',
    s1.notifyOnPortChange === true && s1.theme === 'system',
    `notify=${s1.notifyOnPortChange} theme=${s1.theme}`
  )

  const updated = JSON.parse(
    await evaluate(
      cdp1,
      'window.opsCabin.updateSettings({ notifyOnPortChange: false }).then((s) => JSON.stringify(s))',
      true
    )
  )
  check('设置更新经 IPC 生效', updated.notifyOnPortChange === false)
  check('设置已原子写盘', JSON.parse(readFileSync(settingsFile, 'utf8')).notifyOnPortChange === false)

  // 移动窗口（物理 +120/+80），让"保存的是移动后的位置"可验证。
  // 探针文件写出 ≠ 窗口已完成可见（show 是异步的），拿不到窗口句柄时重试几轮。
  const b0 = (await readJsonWhenReady(join(smokeDir, 'window.json'))).bounds
  let moved = ''
  for (let i = 0; i < 8; i++) {
    moved = moveWindowBy(app1.pid, 120, 80)
    if (moved.startsWith('MOVED')) break
    await wait(800)
  }
  check('窗口被移动（Win32）', moved.startsWith('MOVED'), moved.replace(/\n/g, ' | ') || '无输出')
  await wait(600)

  // 关窗：渲染层 window.close()，等价于点标题栏的关闭按钮
  try {
    await evaluate(cdp1, 'window.close()')
  } catch (error) {
    console.log(`    （window.close 抛出：${error.message}）`)
  }
  await wait(1000)
  check('关窗后应用仍存活（托盘常驻）', (await listTargets()) !== null)

  const visibility = await evaluate(cdp1, 'document.visibilityState').catch(() => 'n/a')
  check('窗口已隐藏', visibility === 'hidden', `visibilityState=${visibility}`)

  const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
  const dx = saved.windowBounds ? saved.windowBounds.x - b0.x : null
  const dy = saved.windowBounds ? saved.windowBounds.y - b0.y : null
  check(
    '关窗时记录了移动后的新位置',
    dx !== null && dy !== null && dx > 0 && dy > 0 && dx >= 30 && dy >= 20,
    `位移=${dx},${dy}（DIP）`
  )

  const trayInfo = await readJsonWhenReady(join(smokeDir, 'tray.json'))
  check('托盘图标非空', trayInfo.empty === false && trayInfo.size.width > 0, JSON.stringify(trayInfo))

  cdp1.close()
  check('退出出口生效（app:quit）', await quitApp(page1, app1))

  console.log('== 第二轮：重启恢复窗口位置 ==')
  // 探针只等「文件存在」不等「文件更新」：不删掉上一轮的 window.json 就可能读到旧坐标
  rmSync(join(smokeDir, 'window.json'), { force: true })
  app1 = launch()
  const page2 = await waitForReadyPage()
  if (!page2) {
    console.error('第二轮启动失败')
    shutdown(1)
  } else {
    const smokeWindow = await readJsonWhenReady(join(smokeDir, 'window.json'))
    check(
      '窗口位置恢复为上次关闭时',
      Math.abs(smokeWindow.bounds.x - saved.windowBounds.x) <= 2 &&
        Math.abs(smokeWindow.bounds.y - saved.windowBounds.y) <= 2,
      `${smokeWindow.bounds.x},${smokeWindow.bounds.y} vs 保存的 ${saved.windowBounds.x},${saved.windowBounds.y}`
    )
    check(
      '窗口尺寸恢复',
      smokeWindow.bounds.width === saved.windowBounds.width &&
        smokeWindow.bounds.height === saved.windowBounds.height,
      `${smokeWindow.bounds.width}x${smokeWindow.bounds.height}`
    )
    check('主进程自检：窗口来自恢复的 bounds', smokeWindow.restored === true)
    check('第二轮退出生效', await quitApp(page2, app1))
  }
}

console.log('')
console.log(failures === 0 ? '✅ E2E 全部通过' : `❌ E2E 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
