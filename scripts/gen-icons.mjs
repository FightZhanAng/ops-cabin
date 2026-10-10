// 生成应用图标资源 —— 无外部依赖（手写最小 PNG 编码器）。
// 图标语言：深色圆形徽章 + 信号绿圆环 + 中心点 ——「舱窗里的雷达」。
//
// 用法：node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/* ---------- 最小 PNG 编码器（RGBA / 8bit / 非隔行） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

function encodePng(size, px) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA

  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- 绘制 ---------- */

const DARK = [15, 23, 42] // #0F172A
const GREEN = [34, 197, 94] // #22C55E

/** 深色徽章圆 + 绿色圆环 + 中心点；边缘做 1px 平滑 */
function drawBadge(size) {
  const px = Buffer.alloc(size * size * 4)
  const center = size / 2
  const R = size * 0.47
  const ringOuter = size * 0.33
  const ringInner = size * 0.265
  const dot = size * 0.08

  const clamp01 = (v) => Math.min(1, Math.max(0, v))
  const cover = (r, d) => clamp01(r - d + 0.5)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center
      const dy = y + 0.5 - center
      const d = Math.hypot(dx, dy)

      const aBadge = cover(R, d)
      const aRing = Math.min(cover(ringOuter, d), clamp01(d - ringInner + 0.5)) * aBadge
      const aDot = cover(dot, d) * aBadge

      let r = DARK[0]
      let g = DARK[1]
      let b = DARK[2]
      const mix = (t, c) => {
        r = r * (1 - t) + c[0] * t
        g = g * (1 - t) + c[1] * t
        b = b * (1 - t) + c[2] * t
      }
      mix(aRing, GREEN)
      mix(aDot, GREEN)

      const i = (y * size + x) * 4
      px[i] = Math.round(r)
      px[i + 1] = Math.round(g)
      px[i + 2] = Math.round(b)
      px[i + 3] = Math.round(aBadge * 255)
    }
  }
  return px
}

/* ---------- 输出 ---------- */

const targets = [
  { name: 'icon.png', size: 256 },
  { name: 'tray.png', size: 32 }
]

mkdirSync(join(root, 'resources'), { recursive: true })
for (const { name, size } of targets) {
  const png = encodePng(size, drawBadge(size))
  writeFileSync(join(root, 'resources', name), png)
  console.log(`generated resources/${name} (${size}x${size}, ${png.length} bytes)`)
}
