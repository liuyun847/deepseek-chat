/**
 * 生成 tools/qr-samples/ 下的固定二维码样本（L3 解码测试的输入）。
 *
 * 为什么要生成脚本而不是只放几张 PNG
 * ==================================
 * 这几张图是「解码能力的基准」：tools/qr-decode-check.ps1 每次跑都要求解出完全相同的串。
 * 若不留生成方式，半年后没人说得清某张 PNG 当初是哪条串、用哪个编码器画的 ——
 * 一旦要改配对串格式，就得凭猜测重新造样本。
 *
 * 被复用的仍是页面那一份编码器（src/services/sync/pairing.ts 的 pairQrMatrix，
 * 与 tools/pair-sim 的编译产物同一份），不是第二套实现。
 *
 * 用法
 *   node tools/qr-samples/generate.mjs                     # 重建全部固定样本 + expected.json
 *   node tools/qr-samples/generate.mjs --uri "<串>" --out <文件>   # 临时生成一张（不入库）
 *
 * 依赖：node:zlib（PNG 的 deflate）与 node:crypto（校验用）。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(path.dirname(HERE))
const BUILD_ENTRY = path.join(ROOT, 'tools/pair-sim/build/src/services/sync/pairing.js')
const TSCONFIG = 'tools/pair-sim/tsconfig.json'
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc')

/** 每模块像素：8 px 足够大（模拟器「从图片选择」缩放后仍清晰），文件也只有几 KB */
const MODULE_PX = 8
/** 静区模块数：二维码规范值 4；小于 4 有些解码器找不到定位图形 */
const QUIET = 4
/** 固定指纹（不是任何真实证书，只用于让串的形状与真实部署一致） */
const F = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

/** 固定样本：每个文件钉住一种解析结果，缺一种就少一类回归保护 */
const SAMPLES = [
  {
    file: 'pair-https.png',
    note: 'HTTPS + 证书指纹 + 未过期（真实部署的形状）',
    // x 用的是 2100-01-01：样本必须「永远未过期」，否则跑几年后这条断言自己会红
    uri: 'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=ABCD2345&f=' + F + '&x=4102444800',
    expect: { ok: true, host: '192.168.124.10:7788', code: 'ABCD2345', expired: false },
  },
  {
    file: 'pair-http-loopback.png',
    note: '明文 HTTP + 回环 + 无指纹（本机自用）',
    uri: 'deepseek-sync://pair?v=1&h=127.0.0.1:7788&c=HJKMNPQR',
    expect: { ok: true, host: '127.0.0.1:7788', code: 'HJKMNPQR', expired: false },
  },
  {
    file: 'pair-expired.png',
    note: 'x 已过期（2020-09 的时间戳，早就过了）—— 解析仍 ok，但 expired=true',
    uri: 'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=23456789&f=' + F + '&x=1600000000',
    expect: { ok: true, host: '192.168.124.10:7788', code: '23456789', expired: true },
  },
  {
    file: 'not-a-pair.png',
    note: '反例：一张正常但不是配对串的二维码（解析应为 scheme 失败）',
    uri: 'https://example.com/hello?v=1&h=192.168.124.10:7788',
    expect: { ok: false, reason: 'scheme' },
  },
]

// ── PNG 编码（灰度 8 位、无滤波）────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** 标准 CRC-32（PNG 每个 chunk 都要） */
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组一个 PNG chunk：长度 + 类型 + 数据 + CRC（CRC 覆盖类型与数据） */
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/**
 * 把二维码矩阵写成灰度 PNG（白 = 255，黑 = 0）。
 *
 * @param matrix pairQrMatrix 的返回值（含 modules / quiet / size）
 * @param dark 返回 true 表示该模块是黑的（数据区坐标）
 * @param modulePx 每模块像素
 * @returns PNG 字节
 */
const encodePng = (matrix, isDark, modulePx) => {
  const size = matrix.size
  const px = size * modulePx
  // 每行：1 个滤波字节（0 = None）+ px 个灰度字节
  const raw = Buffer.alloc((px + 1) * px, 255)
  for (let y = 0; y < px; y += 1) raw[y * (px + 1)] = 0
  for (let row = 0; row < matrix.modules; row += 1) {
    for (let col = 0; col < matrix.modules; col += 1) {
      if (!isDark(row, col)) continue
      const y0 = (row + matrix.quiet) * modulePx
      const x0 = (col + matrix.quiet) * modulePx
      for (let dy = 0; dy < modulePx; dy += 1) {
        const base = (y0 + dy) * (px + 1) + 1 + x0
        raw.fill(0, base, base + modulePx)
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(px, 0)
  ihdr.writeUInt32BE(px, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type 0 = 灰度
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 编译产物（与 pair-qr-sim.mjs 同一套：缺了或过期就重建）──────────────────

const rebuild = () => {
  console.log('[qr-samples] 编译 pairing.ts → tools/pair-sim/build/')
  const result = spawnSync(process.execPath, [TSC, '-p', TSCONFIG], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error('[qr-samples] tsc 失败')
    process.exit(1)
  }
}

const ensureBuild = () => {
  const sourceMtime = fs.statSync(path.join(ROOT, 'src/services/sync/pairing.ts')).mtimeMs
  if (!fs.existsSync(BUILD_ENTRY) || fs.statSync(BUILD_ENTRY).mtimeMs < sourceMtime) {
    rebuild()
  }
}

/** 从矩阵里取模块的明暗（pairQrMatrix 只给 path，这里用同一条规则重算一次坐标断言） */
const darkFromPath = (matrix) => {
  // pairQrMatrix 的 path 里每一段是 "M{x} {y}h{宽}v1h-{宽}z"（坐标已含静区）
  const dark = new Set()
  const re = /M(\d+) (\d+)h(\d+)v1h-\d+z/g
  let m
  while ((m = re.exec(matrix.path)) !== null) {
    const x = Number(m[1]) - matrix.quiet
    const y = Number(m[2]) - matrix.quiet
    const w = Number(m[3])
    for (let i = 0; i < w; i += 1) dark.add((y * matrix.modules + x + i).toString())
  }
  return (row, col) => dark.has((row * matrix.modules + col).toString())
}

const main = async () => {
  const argv = process.argv.slice(2)
  const uriAt = argv.indexOf('--uri')
  const outAt = argv.indexOf('--out')
  ensureBuild()
  const { pairQrMatrix } = await import('file://' + BUILD_ENTRY.replace(/\\/g, '/'))

  if (uriAt !== -1 && outAt !== -1) {
    const uri = argv[uriAt + 1]
    const out = argv[outAt + 1]
    const matrix = pairQrMatrix(uri, QUIET)
    const png = encodePng(matrix, darkFromPath(matrix), MODULE_PX)
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    fs.writeFileSync(out, png)
    console.log(
      '[qr-samples] 已生成 ' + out + '（' + matrix.modules + ' 模块 / ' + matrix.size * MODULE_PX + ' px / ' + png.length + ' B）'
    )
    return
  }

  const expected = []
  for (const sample of SAMPLES) {
    const matrix = pairQrMatrix(sample.uri, QUIET)
    const png = encodePng(matrix, darkFromPath(matrix), MODULE_PX)
    fs.writeFileSync(path.join(HERE, sample.file), png)
    expected.push({ file: sample.file, note: sample.note, uri: sample.uri, expect: sample.expect })
    console.log(
      '[qr-samples] ' + sample.file + ' ← v' + matrix.version + ' / ' + matrix.modules + ' 模块 / ' +
        matrix.size * MODULE_PX + ' px / ' + png.length + ' B'
    )
  }
  fs.writeFileSync(
    path.join(HERE, 'expected.json'),
    JSON.stringify(expected, null, 2) + '\n',
    'utf8'
  )
  console.log('[qr-samples] expected.json 已写（' + expected.length + ' 条）')
}

await main()
