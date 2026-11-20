/**
 * 配对串自检工具：解析（L1）、编码（L2）与服务端选地址（L4）三层，全部脱离浏览器跑。
 * （L3 是二维码解码自检，另一个脚本：tools/qr-decode-check.ps1。）
 *
 * 为什么要有它
 * ============
 * 配对串是「服务端组装、页面渲染、手机扫码」三段的唯一交点，格式错一处就是
 * 「扫出来一串东西但入不了组」，而且这种错在界面上只表现为一句含糊的失败。
 * 所以把它按设计文档的两条验收判据固化成可跑的脚本：
 *
 *   L1 解析：往返、字段校验、大小写、带斜杠、缺字段、IPv6、过期
 *   L2 编码：同一串 → 同一矩阵（矩阵 SHA-256 黄金向量）、模块数（二维码版本）
 *   L4 选地址：服务端 resolvePairTarget + requirePairTls（含「没证书就别画码」这条闸）
 *
 * 被验证的是 src/services/sync/pairing.ts（页面里用的就是同一份代码），
 * 先用 tsc 把它编成 JS（配置见 tools/pair-sim/tsconfig.json，产物在 build/ 下），
 * 再 import 进来 —— 不在本文件里重写一套规则。
 *
 * 用法
 *   node tools/pair-qr-sim.mjs                  # 默认跑 --self-test
 *   node tools/pair-qr-sim.mjs --self-test      # L1 + L2 + L4 全部断言
 *   node tools/pair-qr-sim.mjs --parse "<串>"   # 打印解析出的字段；非法串退出码 1
 *   node tools/pair-qr-sim.mjs --golden         # 只比对矩阵黄金向量
 *   node tools/pair-qr-sim.mjs --build          # 先重新编译 TS 子集再跑
 *   node tools/pair-qr-sim.mjs --svg "<串>"     # 把二维码打成 SVG 到 stdout（人眼/工具用）
 *
 * 退出码：0 = 全部通过；1 = 有断言失败或参数不合法（会指出是哪一条）。
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const BUILD_ENTRY = path.join(ROOT, 'tools/pair-sim/build/src/services/sync/pairing.js')
const TSCONFIG = 'tools/pair-sim/tsconfig.json'
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc')

/** 固定指纹（黄金向量用；只是 64 位十六进制，不代表任何真证书） */
const FINGERPRINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

/**
 * 黄金向量：三条固定串 + 期望的矩阵指纹。
 * 这里钉住的不是「好看」，而是「换库 / 换纠错级别 / 改串格式」这类会静默改变
 * 二维码版本的改动 —— 模块数一跳档，老手机的取景框经验就全废了。
 */
const GOLDEN = [
  {
    name: 'withFingerprint',
    // 带 f 与 x：真实的 HTTPS 部署就是这个形状（137 字符 → v8 / 49 模块）
    uri:
      'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=ABCD2345&f=' +
      FINGERPRINT +
      '&x=1766000000',
    modules: 49,
    version: 8,
    size: 57,
    pathSha256: '6248379080ea5952e31451afcb14a02d704b4da052c0e664d9553c5b28b59e9e',
  },
  {
    name: 'noFingerprint',
    // 不带 f（明文服务，只能走回环）
    uri: 'deepseek-sync://pair?v=1&h=127.0.0.1:7788&c=HJKMNPQR',
    modules: 33,
    version: 4,
    size: 41,
    pathSha256: '42d4353e62f37d7edd5698ece35a0358461877a221ecba3b97579842528322e7',
  },
  {
    name: 'longestHost',
    // 最长 h：15 位 IPv4 + ':' + 5 位端口 → 139 字符，仍是 v8
    uri:
      'deepseek-sync://pair?v=1&h=255.255.255.255:65535&c=23456789&f=' +
      FINGERPRINT +
      '&x=1766000000',
    modules: 49,
    version: 8,
    size: 57,
    pathSha256: '523b00c32eeab54a1564fa01e89c6417e44144367624ca7be0fd34509b7cb023',
  },
]

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** 跑一次 tsc，把 TS 子集编成 JS；失败直接退出（编译错误会由 tsc 自己打印） */
const build = () => {
  const result = spawnSync(process.execPath, [TSC, '-p', TSCONFIG], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error('[pair-qr-sim] 编译失败：node node_modules/typescript/bin/tsc -p ' + TSCONFIG)
    process.exit(1)
  }
}

/**
 * 源文件是否比编译产物新。
 * 不自动重建的话，「改了 pairing.ts 但忘了 --build」会静默跑旧逻辑，断言全部通过 ——
 * 这比没有测试更糟，所以这里按 mtime 自己判断。
 */
const sourcesNewerThanBuild = () => {
  if (!fs.existsSync(BUILD_ENTRY)) {
    return true
  }
  const builtAt = fs.statSync(BUILD_ENTRY).mtimeMs
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return walk(full)
      }
      return /\.(ts|tsx)$/.test(entry.name) ? [fs.statSync(full).mtimeMs] : []
    })
  return ['src/services', 'src/i18n'].some(
    (relative) => Math.max(...walk(path.join(ROOT, relative))) > builtAt
  )
}

const main = async () => {
  const argv = process.argv.slice(2)
  const has = (flag) => argv.includes(flag)
  /** 取 --flag 后面的值（没给就返回空串） */
  const valueOf = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : ''
  }

  if (has('--build') || sourcesNewerThanBuild()) {
    console.log('[pair-qr-sim] 编译 src/services/sync/pairing.ts → tools/pair-sim/build/ …')
    build()
  }

  const mod = await import('file:///' + BUILD_ENTRY.replace(/\\/g, '/'))
  const { buildPairUri, parsePairUri, pairQrMatrix, pairQrSvg, MAX_PAIR_URI_LENGTH } = mod

  // ── --parse：给脚本/人用的一条命令 ────────────────────────────────────────
  if (has('--parse')) {
    const raw = valueOf('--parse')
    const parsed = parsePairUri(raw)
    if (!parsed.ok) {
      console.error('[pair-qr-sim] 解析失败：' + parsed.reason)
      process.exit(1)
    }
    console.log('host        = ' + parsed.host)
    console.log('serverUrl   = ' + parsed.serverUrl)
    console.log('code        = ' + parsed.code)
    console.log('fingerprint = ' + (parsed.fingerprint || '(无，明文服务)'))
    console.log('expiresAt   = ' + (parsed.expiresAt === null ? '(无 x)' : new Date(parsed.expiresAt).toISOString()))
    console.log('expired     = ' + parsed.expired)
    process.exit(0)
  }

  // ── --svg：把二维码打成 SVG，方便人眼看/存盘 ──────────────────────────────
  if (has('--svg')) {
    const raw = valueOf('--svg')
    process.stdout.write(pairQrSvg(raw) + '\n')
    process.exit(0)
  }

  // ── 断言框架 ─────────────────────────────────────────────────────────────
  let passed = 0
  const failures = []
  const check = (name, ok, detail = '') => {
    if (ok) {
      passed += 1
      return
    }
    failures.push(name + (detail ? '（' + detail + '）' : ''))
  }

  // ── L1：解析 ─────────────────────────────────────────────────────────────
  const withFingerprint = buildPairUri({
    host: '192.168.124.10:7788',
    code: 'abcd2345',
    fingerprint: FINGERPRINT,
    expiresAt: 1766000000000,
  })
  check(
    'L1 往返（带指纹与过期时间）',
    withFingerprint ===
      'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=ABCD2345&f=' +
        FINGERPRINT +
        '&x=1766000000',
    withFingerprint
  )
  const roundTrip = parsePairUri(withFingerprint, 1765000000000)
  check(
    'L1 往返解析字段一致',
    roundTrip.ok &&
      roundTrip.host === '192.168.124.10:7788' &&
      roundTrip.serverUrl === 'https://192.168.124.10:7788' &&
      roundTrip.code === 'ABCD2345' &&
      roundTrip.fingerprint === FINGERPRINT &&
      roundTrip.expiresAt === 1766000000000 &&
      roundTrip.expired === false,
    JSON.stringify(roundTrip)
  )
  check(
    'L1 小写配对码会被转成大写',
    roundTrip.ok && roundTrip.code === 'ABCD2345'
  )

  const plainLoopback = buildPairUri({ host: '127.0.0.1:7788', code: 'HJKMNPQR' })
  check('L1 不带 f/x 的串形状', plainLoopback === 'deepseek-sync://pair?v=1&h=127.0.0.1:7788&c=HJKMNPQR', plainLoopback)
  const plainParsed = parsePairUri(plainLoopback)
  check(
    'L1 不带 f 时按明文处理（回环可用）',
    plainParsed.ok && plainParsed.serverUrl === 'http://127.0.0.1:7788' && plainParsed.fingerprint === '',
    JSON.stringify(plainParsed)
  )

  // 字段乱序：参数顺序不该影响解析（服务端按 v,h,c,f,x 生成，但别的实现可能不按这个顺序）
  const shuffled =
    'deepseek-sync://pair?x=1766000000&c=ABCD2345&v=1&h=192.168.124.10:7788&f=' + FINGERPRINT
  const shuffledParsed = parsePairUri(shuffled, 1765000000000)
  check(
    'L1 字段乱序仍能解析',
    shuffledParsed.ok &&
      shuffledParsed.host === '192.168.124.10:7788' &&
      shuffledParsed.code === 'ABCD2345' &&
      shuffledParsed.fingerprint === FINGERPRINT,
    JSON.stringify(shuffledParsed)
  )

  // 坑 1：自定义 scheme 的 hostname 不自动小写 —— 大写 scheme 与 PAIR 必须一样认
  // （实测 new URL('DEEPSEEK-SYNC://PAIR?...').hostname === 'PAIR'，不做 toLowerCase 就永远认不出）
  const upperAll = parsePairUri('DEEPSEEK-SYNC://PAIR?v=1&h=192.168.124.10:7788&c=ABCD2345&f=' + FINGERPRINT)
  check(
    'L1 全大写 scheme+host 可解析（坑 1）',
    upperAll.ok && upperAll.host === '192.168.124.10:7788' && upperAll.serverUrl === 'https://192.168.124.10:7788',
    JSON.stringify(upperAll)
  )

  // 大写 h 里的主机名 → 收敛成小写（DNS 不分大小写）
  const upperHost = parsePairUri('deepseek-sync://pair?v=1&h=NAS.LOCAL:7788&c=ABCD2345&f=' + FINGERPRINT)
  check(
    'L1 大写主机名收敛为小写',
    upperHost.ok && upperHost.host === 'nas.local:7788' && upperHost.serverUrl === 'https://nas.local:7788',
    JSON.stringify(upperHost)
  )

  // 坑 2：带斜杠的 pathname 是 '/'，解析要忽略
  const slash = parsePairUri('deepseek-sync://pair/?v=1&h=192.168.124.10:7788&c=ABCD2345&f=' + FINGERPRINT)
  check('L1 带斜杠的 pathname（坑 2）', slash.ok && slash.host === '192.168.124.10:7788', JSON.stringify(slash))

  // 省略端口 → 7788
  const noPort = parsePairUri('deepseek-sync://pair?v=1&h=192.168.124.10&c=ABCD2345&f=' + FINGERPRINT)
  check('L1 省略端口补 7788', noPort.ok && noPort.host === '192.168.124.10:7788', JSON.stringify(noPort))

  /**
   * 坑 3：旧 WebView 上 new URL(...).hostname 对非特殊 scheme 给空串。
   *
   * 本机雷电 9 的 WebView 是 Chromium 91，实测 new URL('deepseek-sync://pair?v=1').hostname === ''，
   * 而 Node 24 给 'pair'。M4 第一版解析器用 hostname 判定，结果「Node 里全绿、APP 里扫码与粘贴全红」。
   * 这里直接把全局 URL 换成一个「按 Chromium 91 行为」的替身，钉住「解析器不依赖 hostname」这条。
   */
  const RealURL = globalThis.URL
  class Chromium91URL extends RealURL {
    /** 非特殊 scheme 的 authority 在旧引擎里解析不出来 → hostname 返回空串 */
    get hostname() {
      const scheme = String(this.protocol || '')
      const special = scheme === 'http:' || scheme === 'https:' || scheme === 'ws:' || scheme === 'ftp:'
      return special ? super.hostname : ''
    }
  }
  globalThis.URL = Chromium91URL
  let legacy
  try {
    legacy = parsePairUri(withFingerprint, 1765000000000)
  } finally {
    globalThis.URL = RealURL
  }
  check(
    'L1 旧 WebView（hostname 为空）仍能解析（坑 3）',
    legacy.ok && legacy.host === '192.168.124.10:7788' && legacy.code === 'ABCD2345',
    JSON.stringify(legacy)
  )

  // 各类失败分支
  const failuresExpected = [
    ['缺 v', 'deepseek-sync://pair?h=192.168.124.10:7788&c=ABCD2345', 'version'],
    ['v=2', 'deepseek-sync://pair?v=2&h=192.168.124.10:7788&c=ABCD2345', 'version'],
    ['缺 c', 'deepseek-sync://pair?v=1&h=192.168.124.10:7788', 'code'],
    ['c 里含易混字符 0/O/I', 'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=ABCD0O1I', 'code'],
    ['缺 h', 'deepseek-sync://pair?v=1&c=ABCD2345', 'host'],
    ['IPv6 字面量（v1 不支持）', 'deepseek-sync://pair?v=1&h=%5B%3A%3A1%5D:7788&c=ABCD2345', 'host'],
    ['f 不是 64 位', 'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=ABCD2345&f=abc', 'fingerprint'],
    ['不是本应用的 scheme', 'https://pair?v=1&h=192.168.124.10:7788&c=ABCD2345', 'scheme'],
    ['主体不是 pair', 'deepseek-sync://join?v=1&h=192.168.124.10:7788&c=ABCD2345', 'scheme'],
    ['根本不是 URL', '   ', 'scheme'],
    ['非回环且没有 f（明文）', 'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=ABCD2345', 'plaintext'],
    ['超长串', 'deepseek-sync://pair?v=1&h=192.168.124.10:7788&c=ABCD2345&pad=' + 'a'.repeat(MAX_PAIR_URI_LENGTH), 'length'],
  ]
  for (const [name, uri, reason] of failuresExpected) {
    const parsed = parsePairUri(uri)
    check('L1 拒绝：' + name, !parsed.ok && parsed.reason === reason, parsed.ok ? '却解析成功了' : parsed.reason)
  }

  // 过期：x 在过去只是提示，不许直接判失败（安全边界在服务端）
  const expired = parsePairUri(withFingerprint, 1767000000000)
  check('L1 过期的串仍然可解析且标 expired', expired.ok && expired.expired === true, JSON.stringify(expired))

  // buildPairUri 的入参校验：错的东西要当场炸，不许产出一个坏串
  const throws = (fn) => {
    try {
      fn()
      return false
    } catch {
      return true
    }
  }
  check('L1 build 拒绝非法配对码', throws(() => buildPairUri({ host: '127.0.0.1:7788', code: 'ABCD' })))
  check(
    'L1 build 拒绝非法指纹',
    throws(() => buildPairUri({ host: '127.0.0.1:7788', code: 'ABCD2345', fingerprint: 'abc' }))
  )
  check('L1 build 拒绝非法 host', throws(() => buildPairUri({ host: '[::1]:7788', code: 'ABCD2345' })))

  // ── L2：编码 ─────────────────────────────────────────────────────────────
  for (const golden of GOLDEN) {
    const matrix = pairQrMatrix(golden.uri)
    check(
      'L2 模块数 ' + golden.name,
      matrix.modules === golden.modules && matrix.version === golden.version && matrix.size === golden.size,
      'got modules=' + matrix.modules + ' version=' + matrix.version + ' size=' + matrix.size
    )
    check(
      'L2 矩阵指纹 ' + golden.name,
      sha256(matrix.path) === golden.pathSha256,
      'got ' + sha256(matrix.path)
    )
  }
  // 137 字符的配对串必须落在 v8 / 49 模块（设计文档 2.3 的判据）
  check('L2 真实配对串是 v8/49 模块', pairQrMatrix(withFingerprint).modules >= 49, String(pairQrMatrix(withFingerprint).modules))

  const svg = pairQrSvg(withFingerprint, { modulePx: 4 })
  const matrix = pairQrMatrix(withFingerprint)
  check(
    'L2 SVG 尺寸 = 模块数 × 4px（含静区）',
    svg.includes('width="' + matrix.size * 4 + '"') &&
      svg.includes('viewBox="0 0 ' + matrix.size + ' ' + matrix.size + '"') &&
      svg.includes('fill="#fff"') &&
      svg.includes('<path fill="#000"') &&
      svg.includes('shape-rendering="crispEdges"'),
    svg.slice(0, 160)
  )
  check('L2 SVG 只有一个 path（不是逐模块 rect）', (svg.match(/<path /g) || []).length === 1, 'path 数 ' + (svg.match(/<path /g) || []).length)

  // ── L4：服务端选地址（sync-server/pair-uri.mjs，页面与启动日志读的都是它）──
  // 直接 import 服务端那份纯函数模块：规则只有一处实现，这里只钉住「说得出为什么」的几条。
  const { requirePairTls, resolvePairTarget } = await import(
    new URL('../sync-server/pair-uri.mjs', import.meta.url).href
  )
  const pick = (input, hasFingerprint) =>
    requirePairTls(resolvePairTarget({ port: 7788, ...input }), { hasFingerprint })

  // 这一条是必修项：--host 0.0.0.0 --token 但不带证书时，地址可达却没有指纹，
  // 旧实现照样画码（uri 无 f），手机端必然拒 —— 现在必须直接判不可达。
  const lanNoTls = pick({ listenHost: '0.0.0.0', addresses: ['192.168.1.5'] }, false)
  check(
    'L4 非回环 + 没证书 → 不给地址（no-tls）',
    lanNoTls.reachable === false && lanNoTls.host === null && lanNoTls.reason === 'no-tls',
    JSON.stringify(lanNoTls)
  )
  const lanTls = pick({ listenHost: '0.0.0.0', addresses: ['192.168.1.5'] }, true)
  check(
    'L4 非回环 + 有证书 → 给地址',
    lanTls.reachable === true && lanTls.host === '192.168.1.5:7788' && lanTls.reason === null,
    JSON.stringify(lanTls)
  )
  check(
    'L4 显式 --public-host 也要有证书',
    pick({ listenHost: '127.0.0.1', publicHost: 'nas.local:7788' }, false).reason === 'no-tls',
    JSON.stringify(pick({ listenHost: '127.0.0.1', publicHost: 'nas.local:7788' }, false))
  )
  check(
    'L4 显式 --public-host + 有证书 → 用它',
    pick({ listenHost: '0.0.0.0', publicHost: 'nas.local:7788', addresses: [] }, true).host ===
      'nas.local:7788'
  )
  check(
    'L4 回环的毛病优先于 no-tls',
    pick({ listenHost: '127.0.0.1' }, false).reason === 'loopback',
    pick({ listenHost: '127.0.0.1' }, false).reason
  )
  check(
    'L4 没有网卡地址 → no-address',
    pick({ listenHost: '0.0.0.0', addresses: [] }, true).reason === 'no-address',
    pick({ listenHost: '0.0.0.0', addresses: [] }, true).reason
  )

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  const total = passed + failures.length
  if (failures.length === 0) {
    console.log('[pair-qr-sim] 全部通过（' + passed + '/' + total + '）')
    process.exit(0)
  }
  console.error('[pair-qr-sim] 失败 ' + failures.length + ' / ' + total + ' 项：')
  for (const failure of failures) {
    console.error('  ✗ ' + failure)
  }
  process.exit(1)
}

await main()
