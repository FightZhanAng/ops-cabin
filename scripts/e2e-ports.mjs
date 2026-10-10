// M4 端口采集引擎的端到端验证（CDP 驱动 + 真实网络服务）。
//
// 覆盖：与外部 netstat 的集合对比 / 真实服务端口与 PID 精确匹配 / 多地址合并 /
//       订阅推送 / 关注清单 CRUD 与落盘 / 变化检测（occupy/release）+ 事件落盘。
//
// 用法：node scripts/e2e-ports.mjs
// 说明：测试会启动两个本地 http 服务（51733/51734）并在关注它们时触发
//       系统通知（这是被验证的功能本身）。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 19227
const PORT_A = 51733
const PORT_B = 51734
const userDataDir = join(tmpdir(), 'ops-cabin-ports-e2e-userdata')
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

let failures = 0
let currentChild = null
let serverA = null
let serverB = null
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
  for (const child of [serverA, serverB]) {
    try {
      child?.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
  serverA = null
  serverB = null
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

/* ---------------- 本地服务（被测对象） ---------------- */

function startServer(port, host) {
  const listen = host ? `listen(${port}, '${host}')` : `listen(${port})`
  return spawn(
    process.execPath,
    ['-e', `require('http').createServer((req, res) => res.end('ok')).${listen}; setInterval(() => {}, 1000)`],
    { stdio: 'ignore' }
  )
}

/* ---------------- 外部 netstat（对比基准） ---------------- */

function collectNetstat() {
  const result = spawnSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true })
  const set = new Set()
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue
    const colon = parts[1].lastIndexOf(':')
    const port = Number(parts[1].slice(colon + 1))
    const pid = Number(parts[4])
    if (Number.isInteger(port) && Number.isInteger(pid)) set.add(`${port}:${pid}`)
  }
  return set
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

  /* ---------- A. 基础采集与外部 netstat 对比 ---------- */
  console.log('== A. 基础采集与 netstat 对比 ==')
  // 等 React 挂载后再离开总览页：总览（M6 起）会常驻订阅端口推送，
  // 测试的订阅计数需要干净环境（不确认离开，卸载就不可靠）
  await waitForDom(cdp, `document.querySelectorAll('nav button').length >= 4`, 15000)
  await evaluate(
    cdp,
    `[...document.querySelectorAll('nav button')].find((b) => b.textContent === '磁盘')?.click(); 'ok'`
  )
  check(
    '已离开总览页（进入磁盘页）',
    await waitForDom(cdp, `!!document.querySelector('[data-testid="scan-start"]')`, 8000)
  )
  const ext1 = collectNetstat()
  const snapshot = JSON.parse(
    await invoke('window.opsCabin.listPorts().then((s) => JSON.stringify(s))')
  )
  const ext2 = collectNetstat()
  check(
    '采集返回快照',
    snapshot !== null && Array.isArray(snapshot.entries),
    `entries=${snapshot?.entries?.length}`
  )
  const named = (snapshot?.entries ?? []).filter((e) => e.processName !== null).length
  check(
    '绝大多数条目带进程信息',
    named >= (snapshot?.entries?.length ?? 0) - 2,
    `${named}/${snapshot?.entries?.length}`
  )

  const appSet = new Set(
    snapshot.entries
      .filter((e) => e.protocol === 'tcp' && e.pid > 0)
      .map((e) => `${e.port}:${e.pid}`)
  )
  const union = new Set([...ext1, ...ext2])
  const intersection = new Set([...ext1].filter((key) => ext2.has(key)))
  const extras = [...appSet].filter((key) => !union.has(key))
  const missing = [...intersection].filter((key) => !appSet.has(key))
  check('不多报（采集结果都在外部两次采样之内）', extras.length === 0, extras.slice(0, 5).join(' '))
  check('不遗漏（外部稳定监听的都采到）', missing.length === 0, missing.slice(0, 5).join(' '))

  /* ---------- B. 真实服务端口（PID 精确匹配） ---------- */
  console.log('== B. 真实服务端口 ==')
  serverA = startServer(PORT_A, '127.0.0.1')
  // 轮询等待端口真正出现（容忍 node 冷启动的慢速与端口竞争）
  let entryA = null
  const bDeadline = Date.now() + 10000
  while (Date.now() < bDeadline) {
    await wait(500)
    const snap = JSON.parse(
      await invoke('window.opsCabin.listPorts().then((s) => JSON.stringify(s))')
    )
    const found = snap.entries.find((e) => e.port === PORT_A && e.protocol === 'tcp')
    if (found) {
      entryA = found
      if (found.pid === serverA.pid) break
    }
    if (serverA.exitCode !== null) break // 服务自己退出了（bind 失败）
  }
  check('服务 A 存活', serverA.exitCode === null, `exit=${serverA.exitCode}`)
  check('新服务端口出现', Boolean(entryA), `port=${PORT_A}`)
  check('PID 精确匹配', entryA?.pid === serverA.pid, `entry=${entryA?.pid} vs spawn=${serverA.pid}`)
  check('识别出进程名（node）', /node/i.test(entryA?.processName ?? ''), entryA?.processName ?? 'null')
  check(
    '监听到 127.0.0.1（地址正确）',
    entryA?.addresses.includes('127.0.0.1') === true,
    JSON.stringify(entryA?.addresses)
  )

  /* ---------- C. 多地址合并 ---------- */
  console.log('== C. 多地址合并（双栈） ==')
  serverB = startServer(PORT_B)
  let entriesB = []
  const cDeadline = Date.now() + 8000
  while (Date.now() < cDeadline) {
    await wait(500)
    const snap = JSON.parse(
      await invoke('window.opsCabin.listPorts().then((s) => JSON.stringify(s))')
    )
    entriesB = snap.entries.filter((e) => e.port === PORT_B && e.protocol === 'tcp')
    if (entriesB.length > 0) break
  }
  check('同端口只保留一条（地址已合并）', entriesB.length === 1, `count=${entriesB.length}`)
  check(
    '地址列表登记完整',
    (entriesB[0]?.addresses.length ?? 0) >= 1,
    JSON.stringify(entriesB[0]?.addresses)
  )

  /* ---------- D. 订阅推送 ---------- */
  console.log('== D. 订阅推送 ==')
  await invoke(
    `window.__snapshots = []; window.opsCabin.onPortsSnapshot((s) => window.__snapshots.push(s.at)); 'ok'`
  )
  await invoke(
    `window.__changes = []; window.opsCabin.onPortsChanges((cs) => window.__changes.push(...cs)); 'ok'`
  )
  await invoke('window.opsCabin.subscribePorts().then(() => "ok")')
  await wait(5000)
  const pushCount = await evaluate(cdp, 'window.__snapshots.length')
  check('订阅后持续推送快照（2s 周期）', pushCount >= 2, `count=${pushCount}`)

  /* ---------- E. 关注清单 CRUD 与变化检测 ---------- */
  console.log('== E. 关注清单与变化检测 ==')
  stopServers()
  await wait(2500) // 让监控看到端口空闲，建立参考状态

  const added = JSON.parse(
    await invoke(
      `window.opsCabin.addWatch({ port: ${PORT_A}, label: '测试服务 A' }).then((w) => JSON.stringify(w))`
    )
  )
  check(
    '加入关注清单',
    added.some((w) => w.port === PORT_A && w.label === '测试服务 A')
  )

  // 先等一个采样周期：让监控在「端口空闲」时建立基线（基线建立不报变化），
  // 之后再启动服务，才能观察到一个干净的 occupy
  await wait(2500)

  // 启动服务 → 应推送 occupy
  serverA = startServer(PORT_A, '127.0.0.1')
  await wait(3500)
  let changes = JSON.parse(await evaluate(cdp, 'JSON.stringify(window.__changes)'))
  const occupy = changes.find((c) => c.type === 'occupy' && c.port === PORT_A)
  check('检测到「被占用」变化', Boolean(occupy), JSON.stringify(changes))
  check(
    '变化里带占用进程信息',
    typeof occupy?.process === 'string' && /node/i.test(occupy.process),
    occupy?.process ?? ''
  )

  // 停服务 → 应推送 release
  stopServers()
  await wait(3500)
  changes = JSON.parse(await evaluate(cdp, 'JSON.stringify(window.__changes)'))
  const release = changes.find((c) => c.type === 'release' && c.port === PORT_A)
  check('检测到「已释放」变化', Boolean(release), JSON.stringify(changes.slice(-3)))

  // 事件落盘
  const events = JSON.parse(
    await invoke('window.opsCabin.listPortEvents().then((e) => JSON.stringify(e))')
  )
  check(
    '变化事件已落盘（含 occupy 与 release）',
    events.some((e) => e.type === 'occupy' && e.port === PORT_A) &&
      events.some((e) => e.type === 'release' && e.port === PORT_A),
    `events=${events.length}`
  )

  // 更新与移除
  const updated = JSON.parse(
    await invoke(
      `window.opsCabin.updateWatch(${PORT_A}, { label: '改名后的服务' }).then((w) => JSON.stringify(w))`
    )
  )
  check('更新关注项名称', updated.some((w) => w.port === PORT_A && w.label === '改名后的服务'))
  const removed = JSON.parse(
    await invoke(`window.opsCabin.removeWatch(${PORT_A}).then((w) => JSON.stringify(w))`)
  )
  check('移除关注项', !removed.some((w) => w.port === PORT_A))

  // 关注清单落盘（隔离的 userData 目录）
  const watchlistOnDisk = JSON.parse(readFileSync(join(userDataDir, 'watchlist.json'), 'utf8'))
  check(
    '关注清单已落盘（移除后为空表）',
    Array.isArray(watchlistOnDisk) && watchlistOnDisk.length === 0
  )

  /* ---------- F. 退订停止推送 ---------- */
  console.log('== F. 退订 ==')
  await invoke('window.opsCabin.unsubscribePorts().then(() => "ok")')
  await wait(4000) // 等在途采样完成（含最长的一次进程表刷新）
  const countBefore = await evaluate(cdp, 'window.__snapshots.length')
  await wait(6000) // 两个采样周期内不应再有新推送
  const countAfter = await evaluate(cdp, 'window.__snapshots.length')
  check('退订后停止推送', countAfter === countBefore, `${countBefore} → ${countAfter}`)

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

console.log('')
console.log(failures === 0 ? '✅ E2E-PORTS 全部通过' : `❌ E2E-PORTS 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
