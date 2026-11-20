/**
 * 配对串（二维码内容）在页面侧的唯一实现：解析 + 生成二维码矩阵，全是纯函数。
 *
 * 为什么页面不自己拼串
 * ====================
 * 串里的地址必须是「手机能连到的那台机器」，而网页永远在回环上（页面由 local-server 托管，
 * 它只绑 127.0.0.1；isLoopbackHostname 也把同源限制在回环），location.origin 恒为
 * 127.0.0.1:7789 —— 手机连上去等于连自己。所以串由服务端组装（sync-server/pair-uri.mjs），
 * 页面只做两件事：把 uri 画成矩阵、把扫回来的串解析成字段。
 *
 * 解析有三个真坑（服务端那份 parsePairUri 只管前两个，它只在 Node 里跑）
 * ==============================================================
 *   1) 自定义 scheme 的 hostname 不自动小写：new URL('DEEPSEEK-SYNC://PAIR?...').hostname === 'PAIR'。
 *      http(s) 这类 special scheme 才会小写 —— 别把浏览器的习惯带过来，判据必须 toLowerCase()。
 *   2) 带斜杠也合法：deepseek-sync://pair/?v=1 的 pathname 是 '/'，解析要忽略 pathname，
 *      不能断言它为空。
 *   3) **旧 WebView 上 new URL('deepseek-sync://pair?...').hostname 是空串**（Chromium 91 实测），
 *      现代引擎给 'pair'。所以 authority 与 scheme 全部从原始文本切，见 authorityOf()。
 *
 * 复用而不是重写：地址规范沿用 api.ts 的 normalizeServerUrl（含「明文只许回环」这条），
 * 指纹规范沿用 tls.ts 的 normalizeCertFingerprint（全仓唯一的一套 [0-9a-f]{64} 规则）。
 */

import qrcode from 'qrcode-generator'

import { normalizeServerUrl } from './api.js'
import { normalizeCertFingerprint } from './tls.js'

/** scheme 名（不带冒号），与服务端 PAIR_SCHEME 一致 */
export const PAIR_SCHEME = 'deepseek-sync'
/** scheme 后面的主体；判断「是不是本应用的码」靠它 */
export const PAIR_HOST = 'pair'
/** 协议版本；未知值一律拒绝并提示升级 */
export const PAIR_VERSION = '1'
/** h 里省略端口时的默认端口（与服务端默认端口一致） */
export const PAIR_DEFAULT_PORT = 7788
/** 配对码格式：8 位，去掉 0/O/1/I；解析时大小写都收（服务端 join 也这么收） */
export const PAIR_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/
/** h 的合法形态：主机名/IPv4 + 可选端口；v1 明确不支持 IPv6 字面量（方括号一律拒） */
const PAIR_HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$/

/**
 * 串长上限（字符）。
 * 真实取值最长 139（h 取 15 位 IPv4 + ':' + 5 位端口）；留足余量只为挡住「粘贴了 1 MB 东西」
 * 这种输入，不是协议约束。
 */
export const MAX_PAIR_URI_LENGTH = 512

/**
 * 解析失败的原因；界面按它选一句能照做的文案（文案在 M4/M5 的扫码界面里接）。
 * 'expiry' 独立于 'host'：x 写错是过期时间的问题，报「服务地址不合法」会把人带去改地址。
 */
export type PairFailure =
  | 'length'
  | 'scheme'
  | 'version'
  | 'host'
  | 'plaintext'
  | 'code'
  | 'fingerprint'
  | 'expiry'

/** 解析成功后的字段 */
export type ParsedPair = {
  /** host:port（原样回填到「服务地址」输入框时就差协议） */
  host: string
  /** 规范化后的服务地址，可直接交给 api.ts 的请求函数 */
  serverUrl: string
  /** 8 位配对码（已转大写） */
  code: string
  /** 证书指纹；空串表示串里没有 f（明文服务，只能走回环） */
  fingerprint: string
  /** 过期时间（毫秒）；没有 x 时为 null */
  expiresAt: number | null
  /** 已经过了 x（只用于提示，仍然允许尝试：安全边界在服务端） */
  expired: boolean
}

export type PairParseResult = ({ ok: true } & ParsedPair) | { ok: false; reason: PairFailure }

/**
 * 取「scheme://authority」里的 authority（小写），不走 URL.hostname。
 *
 * 为什么不用 URL（第三个坑，M4 实测踩到）
 * ======================================
 * 旧 WebView 对**非特殊 scheme** 的 authority 处理和新规范不一致：
 * 本机雷电 9 的 WebView 是 Chromium 91，在那里
 *   new URL('deepseek-sync://pair?v=1').hostname === ''      ← 空串！
 * 而 Node 24 / 现代浏览器给 'pair'。靠 hostname 判定「是不是本应用的码」，
 * 在真机（旧 WebView）上会把每一条合法串都判成 scheme 失败 —— 实测 APP 里扫码与粘贴
 * 两条路全红，而 Node 侧的工具全绿，正是这类「引擎差异」最难查的地方。
 *
 * 所以 scheme 与 authority 都从原始文本切（纯字符串操作，跨引擎一致），
 * URL 只用来读 searchParams（这一条各引擎行为一致）。
 *
 * @param text 原始串（未 trim 也行，调用方已 trim）
 * @param scheme scheme 名（不带冒号）
 * @returns authority 的小写形式；scheme 不匹配时返回 null
 */
const authorityOf = (text: string, scheme: string): string | null => {
  const prefix = scheme + '://'
  if (text.slice(0, prefix.length).toLowerCase() !== prefix) {
    return null
  }
  const rest = text.slice(prefix.length)
  let end = rest.length
  for (const stop of ['/', '?', '#']) {
    const index = rest.indexOf(stop)
    if (index >= 0 && index < end) {
      end = index
    }
  }
  return rest.slice(0, end).toLowerCase()
}

/**
 * 解析配对串。
 *
 * 只判格式与字段，不发请求；x 过期只置 expired 标记（服务端才是闸）。
 *
 * @param raw 扫码/粘贴得到的原始串
 * @param now 当前时间（毫秒），测试时注入用
 * @returns ok:true 带全部字段；ok:false 带失败原因
 */
export const parsePairUri = (raw: string, now: number = Date.now()): PairParseResult => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'scheme' }
  }
  const text = raw.trim()
  if (text.length > MAX_PAIR_URI_LENGTH) {
    return { ok: false, reason: 'length' }
  }
  // 坑 1 + 坑 3：scheme 与 authority 一律从文本切（旧 WebView 的 URL.hostname 对
  // 非特殊 scheme 给空串，且不自动小写）。URL 只留给 searchParams 用。
  const authority = authorityOf(text, PAIR_SCHEME)
  if (authority !== PAIR_HOST) {
    return { ok: false, reason: 'scheme' }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'scheme' }
  }
  if (url.protocol !== PAIR_SCHEME + ':') {
    return { ok: false, reason: 'scheme' }
  }
  // 坑 2：pathname 可能是 '/'，忽略它（不做任何断言）
  const params = url.searchParams
  if (params.get('v') !== PAIR_VERSION) {
    return { ok: false, reason: 'version' }
  }
  const hostRaw = params.get('h') ?? ''
  if (!PAIR_HOST_PATTERN.test(hostRaw) || hostRaw.includes('[')) {
    return { ok: false, reason: 'host' }
  }
  const [hostName, portText] = hostRaw.split(':')
  const port = portText === undefined ? PAIR_DEFAULT_PORT : Number(portText)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'host' }
  }
  // 主机名一律小写：DNS 不分大小写，不收敛会出现「同一个服务两种写法」，
  // 回填到设置里与已保存的地址比字符串就会判定为不同（服务端那边也小写）
  const host = hostName.toLowerCase() + ':' + port
  const fingerprintRaw = params.get('f')
  const fingerprint = fingerprintRaw === null ? '' : normalizeCertFingerprint(fingerprintRaw)
  if (fingerprintRaw !== null && !fingerprint) {
    return { ok: false, reason: 'fingerprint' }
  }
  const code = (params.get('c') ?? '').trim().toUpperCase()
  if (!PAIR_CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'code' }
  }
  const expiresRaw = params.get('x')
  let expiresAt: number | null = null
  if (expiresRaw !== null) {
    const seconds = Number(expiresRaw)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { ok: false, reason: 'expiry' }
    }
    expiresAt = Math.floor(seconds) * 1000
  }
  // 有 f 说明服务是 HTTPS（要固定这张证书）；没有 f 就是明文，而明文只允许回环。
  // 放在最后一步：字段本身的毛病（码写错、指纹不是 64 位）优先报，否则「明文」会把它们盖住。
  const serverUrl = normalizeServerUrl((fingerprint ? 'https://' : 'http://') + host)
  if (!serverUrl) {
    return { ok: false, reason: fingerprint ? 'host' : 'plaintext' }
  }
  return {
    ok: true,
    host,
    serverUrl,
    code,
    fingerprint,
    expiresAt,
    expired: expiresAt !== null && now >= expiresAt,
  }
}

/**
 * 组装配对串。
 *
 * 页面不靠它出图（uri 由服务端给），它存在的理由是「格式只有一处实现」：
 * 工具与单测用它做往返（build → parse → 字段相等），将来要加字段也只改这里。
 *
 * @param input.host host:port
 * @param input.code 8 位配对码
 * @param input.fingerprint 证书指纹；空串/null 表示明文服务，串里不带 f
 * @param input.expiresAt 过期时间（毫秒）；null 不带 x
 * @returns 自描述串
 */
export const buildPairUri = (input: {
  host: string
  code: string
  fingerprint?: string | null
  expiresAt?: number | null
}): string => {
  const [hostName, portText] = input.host.trim().toLowerCase().split(':')
  const port = portText === undefined ? PAIR_DEFAULT_PORT : Number(portText)
  if (!PAIR_HOST_PATTERN.test(input.host.trim().toLowerCase())) {
    throw new Error('配对串的 host 不合法：' + input.host)
  }
  const code = input.code.trim().toUpperCase()
  if (!PAIR_CODE_PATTERN.test(code)) {
    throw new Error('配对串的 code 不合法：' + input.code)
  }
  const parts = ['v=' + PAIR_VERSION, 'h=' + hostName + ':' + port, 'c=' + code]
  const fingerprint = normalizeCertFingerprint(input.fingerprint ?? '')
  if (input.fingerprint && !fingerprint) {
    throw new Error('配对串的证书指纹不合法')
  }
  if (fingerprint) {
    parts.push('f=' + fingerprint)
  }
  if (input.expiresAt !== null && input.expiresAt !== undefined) {
    parts.push('x=' + Math.floor(input.expiresAt / 1000))
  }
  return PAIR_SCHEME + '://' + PAIR_HOST + '?' + parts.join('&')
}

/** 二维码矩阵（渲染所需的全部数据，都是可字符串断言的） */
export type PairQr = {
  /** 版本号 1–40；137 字符的配对串 @ECC M 落在 8 */
  version: number
  /** 数据区模块数（不含静区）：49 = version 8 */
  modules: number
  /** 静区（每边）模块数 */
  quiet: number
  /** viewBox 的边长（模块数）= modules + 2 × quiet */
  size: number
  /** 单条 <path> 的 d：每行把相邻黑模块合并成一段，坐标已含静区偏移 */
  path: string
}

/**
 * 能把内容编成二维码的长度上限（字符）。超了由 pairQrMatrix 抛错，不交给库自己抛。
 *
 * 为什么需要一个自己的上限：qrcode-generator 的 addData 只接受 8 位字节模式，
 * 到 v40（最高的那一版）也放不下 2953 字节，超过就抛「code length overflow」——
 * 一旦这个异常从渲染路径里冒出去，整张设置页会白屏。而录入路径（粘贴任意文本、
 * 扫到别人的码）本身可能给出任意长度的串，所以必须在这里拦一道。
 *
 * 取 1200 是为了给真实取值留 8 倍余量（最长 139 字符），同时远离库的上限：v40 在
 * 纠错级别 M 下约 2331 字节，1200 字符一定编得出来。
 */
export const MAX_PAIR_QR_LENGTH = 1200

/**
 * 把配对串编成二维码矩阵。
 *
 * 不用库自带的 createSvgTag：它逐模块吐 <rect>，同一张码 33 KB；这里每行合并相邻黑模块，
 * 用一条 <path> 表达（约 8–10 KB），并且只返回数据 —— 由调用方决定塞进 React 的 <svg>
 * 还是写成字符串。
 *
 * @param uri 配对串
 * @param quiet 静区模块数，默认 4（规范值；小于 4 会让部分扫码器找不到定位）
 * @returns 矩阵数据
 * @throws 内容为空或超过 MAX_PAIR_QR_LENGTH，或库自身编不出来（v40 也放不下）
 */
export const pairQrMatrix = (uri: string, quiet = 4): PairQr => {
  const text = typeof uri === 'string' ? uri : ''
  if (!text) {
    throw new Error('二维码内容为空')
  }
  if (text.length > MAX_PAIR_QR_LENGTH) {
    throw new Error(
      '二维码内容过长：' + text.length + ' 字符，上限 ' + MAX_PAIR_QR_LENGTH + ' 字符'
    )
  }
  // 纠错级别 M：屏幕对屏幕的常规取值（约 15% 容错），且不把版本推高，见设计文档 2.3
  const qr = qrcode(0, 'M')
  try {
    qr.addData(text)
    qr.make()
  } catch (error) {
    // 走到了长度上限之外的原因（编码表/库自身限制）：换成一眼能懂的说法，别把库的错抛给界面
    throw new Error(
      '这段内容无法生成二维码：' + (error instanceof Error ? error.message : String(error))
    )
  }
  const modules = qr.getModuleCount()
  const rows: string[] = []
  for (let row = 0; row < modules; row += 1) {
    let col = 0
    while (col < modules) {
      if (!qr.isDark(row, col)) {
        col += 1
        continue
      }
      const start = col
      while (col < modules && qr.isDark(row, col)) {
        col += 1
      }
      const width = col - start
      rows.push('M' + (start + quiet) + ' ' + (row + quiet) + 'h' + width + 'v1h-' + width + 'z')
    }
  }
  return {
    version: (modules - 17) / 4,
    modules,
    quiet,
    size: modules + quiet * 2,
    path: rows.join(''),
  }
}

/**
 * 配对串 → 完整 <svg> 字符串（白底黑块、crispEdges）。
 *
 * 页面上用的是 React 的 <svg>（见 components/settings/PairQr.tsx）；这个函数给工具与
 * 黄金向量测试用 —— 同一份矩阵能脱离浏览器断言，也能直接存成 .svg 看。
 *
 * @param uri 配对串
 * @param options.modulePx 每个模块的像素数，默认 4（实测 2.5 px/模块才到解码边界，4 留了余量）
 * @param options.quiet 静区模块数，默认 4
 * @returns svg 源码；底色写死 #fff —— 反相（深色底浅模块）会让部分解码器认不出来
 */
export const pairQrSvg = (uri: string, options: { modulePx?: number; quiet?: number } = {}): string => {
  const modulePx = options.modulePx ?? 4
  const matrix = pairQrMatrix(uri, options.quiet ?? 4)
  const px = matrix.size * modulePx
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    px +
    '" height="' +
    px +
    '" viewBox="0 0 ' +
    matrix.size +
    ' ' +
    matrix.size +
    '" shape-rendering="crispEdges">' +
    '<rect width="' +
    matrix.size +
    '" height="' +
    matrix.size +
    '" fill="#fff"/>' +
    '<path fill="#000" d="' +
    matrix.path +
    '"/></svg>'
  )
}
