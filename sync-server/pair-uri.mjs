/**
 * 配对串（二维码内容）：服务端唯一负责组装，工具与对拍用它解析。
 *
 * 为什么放在服务端
 * ================
 * 串里必须有「手机能连到的那个地址」。网页永远在回环上（页面由 local-server 托管，
 * 只绑 127.0.0.1；src/services/localService.ts 的 LOOPBACK_HOSTS 也把同源限制在回环），
 * location.origin 恒为 127.0.0.1:7789 —— 手机连上去等于连自己。只有服务端知道
 * 自己监听在哪、这台机器有哪些网卡，所以串只能由服务端拼（页面拿到 pair.uri 后只负责画矩阵）。
 *
 * 格式（v1，见 .dsh/.project/deepseek-chat-本地服务/QR-PAIRING-DESIGN.md 第 2 节）
 * ================================================================
 *   deepseek-sync://pair?v=1&h=<host[:port]>&c=<8位码>[&f=<64hex>][&x=<unix秒>]
 *
 *   v  协议版本，未知值由客户端拒绝并提示升级（当前只有 1）
 *   h  服务地址：IPv4 或主机名，可带端口；省端口即 7788。v1 不支持 IPv6 字面量
 *   c  8 位配对码，字母表与 server.mjs 的 newInviteCode 同一套（去掉 0/O/1/I）
 *   f  证书 DER 的 SHA-256（64 位小写十六进制）。出现即代表 HTTPS + 要固定这张证书；
 *      不出现代表明文服务（客户端会拒掉非回环的明文地址）
 *   x  过期时间（Unix 秒）= floor(invite.expiresAt / 1000)；只用于客户端 UX，
 *      安全边界仍在服务端（码一次性 + 10 分钟 TTL）
 *
 * 解析侧的两个真坑（客户端 TS 版 src/services/sync/pairing.ts 同样处理）
 * ==================================================
 *   1) 自定义 scheme 的 hostname 不自动小写：new URL('DEEPSEEK-SYNC://PAIR?...').hostname === 'PAIR'，
 *      所以判据必须 toLowerCase()（http/https 这类 special scheme 才会自动小写）。
 *   2) 带斜杠也合法：deepseek-sync://pair/?v=1 的 pathname 是 '/'，解析要忽略 pathname。
 *
 * 零依赖：只用 node: 内置模块（与 sync-server 其余文件一致）。
 */

import os from 'node:os'

import { normalizeCertFingerprint } from './cert-fingerprint.mjs'

/** scheme 名（去掉冒号） */
export const PAIR_SCHEME = 'deepseek-sync'
/** scheme 后面的主体；判断「是不是本应用的码」就靠它 */
export const PAIR_HOST = 'pair'
/** 协议版本；改字段语义时才加 1 */
export const PAIR_VERSION = '1'
/** h 里省略端口时的默认端口（与 server.mjs 的默认端口一致） */
export const PAIR_DEFAULT_PORT = 7788
/** 配对码字母表：与 server.mjs 的 CODE_ALPHABET 逐字符一致（去掉 0/O/1/I 等易混字符） */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** 配对码格式（8 位；解析时大小写都收，服务端 join 也这么收） */
export const PAIR_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/
/**
 * h 的合法形态：主机名/IPv4 + 可选端口。
 * 明确排除方括号 —— v1 不支持 IPv6 字面量（new URL 会把 [::1] 里的方括号留在 hostname 里，
 * 拼进 h 之后再被 URL 解析一次就会错位，留给 v2）。
 */
export const PAIR_HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$/

/**
 * 虚拟网卡的 MAC 前缀（小写、去分隔符）。
 * 「第一个非 internal IPv4」这种写法在某些机器上会把二维码指到虚拟网卡上，而二维码
 * 不可点选、只能重扫，选错的代价是用户拿着手机反复试 —— 所以这里主动过滤。
 *   0a:00:27 / 08:00:27  VirtualBox（前者是设置过本地管理位置的 variant）
 *   00:50:56 / 00:0c:29 / 00:05:69  VMware
 *   00:15:5d  Hyper-V
 */
const VIRTUAL_MAC_PREFIXES = ['0a0027', '080027', '005056', '000c29', '000569', '00155d']

/** 回环监听地址（与服务端 LOOPBACK_HOSTS 同口径；0.0.0.0 / :: 不算回环） */
const LOOPBACK_LISTEN = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 地址优先级：数字越小越优先。
 * @param address IPv4 字符串
 * @returns 0..3；非法/其它地址给 3（垫底但不丢）
 */
function addressRank(address) {
  if (/^192\.168\./.test(address)) return 0
  if (/^10\./.test(address)) return 1
  const vm = /^172\.(\d{1,3})\./.exec(address)
  if (vm) {
    const second = Number(vm[1])
    if (second >= 16 && second <= 31) return 2
  }
  return 3
}

/**
 * 这台机器上「可能被手机连到」的 IPv4 地址，带优先级。
 *
 * 过滤：internal、169.254.0.0/16（APIPA，DHCP 失败时的自配地址）、127.0.0.0/8、
 *       虚拟网卡 MAC。
 * 排序：192.168.* > 10.* > 172.16-31.* > 其它；同一档按网卡序号（os.networkInterfaces 的顺序）。
 *
 * @returns {{ address: string, iface: string, rank: number }[]} 已排序；没有候选时是空数组
 */
export function localAddressCandidates() {
  const out = []
  const interfaces = os.networkInterfaces()
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // node 18 起 family 是字符串，旧版本是数字 4；两种都收
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4
      if (!isIpv4 || entry.internal) continue
      const address = entry.address
      if (address.startsWith('169.254.') || address.startsWith('127.')) continue
      const mac = String(entry.mac ?? '').replace(/[:-]/g, '').toLowerCase()
      if (VIRTUAL_MAC_PREFIXES.some((prefix) => mac.startsWith(prefix))) continue
      out.push({ address, iface, rank: addressRank(address) })
    }
  }
  // sort 是稳定的：同档次保持 os.networkInterfaces() 的枚举顺序（≈ 网卡序号）
  return out.sort((a, b) => a.rank - b.rank)
}

/**
 * 把「主机[:端口]」收敛成 h 字段的规范写法（去空白、小写；省端口时补回默认端口）。
 *
 * @param raw 用户/--public-host 给的写法，如 192.168.124.10:7788、nas.local
 * @param fallbackPort 省略端口时用的端口（通常就是本服务监听端口）
 * @returns {{ host: string, port: number } | null} 不合法时 null
 */
export function normalizePairHost(raw, fallbackPort = PAIR_DEFAULT_PORT) {
  if (typeof raw !== 'string') return null
  let value = raw.trim()
  if (!value) return null
  // 允许写完整 URL（--public-host https://nas.local:7789 这种反代场景）
  const urlMatch = /^https?:\/\/([^/?#]+)/i.exec(value)
  if (urlMatch) value = urlMatch[1]
  value = value.toLowerCase()
  if (!PAIR_HOST_PATTERN.test(value)) return null
  const [host, portText] = value.split(':')
  if (!host) return null
  const port = portText === undefined ? fallbackPort : Number(portText)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

/**
 * 这次该往二维码里放哪个地址（等价于设计文档 3.1 的流程图）。
 *
 * 规则：
 *   1. 给了 publicHost → 一律用它，并且认为「可达」（反代 / 端口映射 / 域名这些场景，
 *      服务端自己绑的是回环也正常）
 *   2. 没给 publicHost 且监听在回环 → 不可达（reason='loopback'）：手机连 127.0.0.1 是连自己。
 *      注意 0.0.0.0 不算回环。
 *   3. 监听在某个具体地址 → 用它
 *   4. 监听在 0.0.0.0 / :: → 枚举网卡取第一名；一个候选都没有 → 不可达（reason='no-address'）
 *
 * @param {object} input
 * @param input.listenHost 本服务实际监听的地址（--host / SYNC_HOST）
 * @param input.port 本服务实际端口
 * @param input.publicHost 显式指定的对外地址（--public-host / SYNC_PUBLIC_HOST）；空串表示没给
 * @param input.addresses 可选：测试时注入候选地址列表（默认走 localAddressCandidates()）
 * @returns {{ host: string | null, reachable: boolean,
 *             reason: 'loopback' | 'no-address' | null, candidates: string[] }}
 */
export function resolvePairTarget({ listenHost, port, publicHost = '', addresses } = {}) {
  const listen = String(listenHost ?? '').trim().toLowerCase()
  const explicit = normalizePairHost(publicHost, port)
  if (explicit) {
    const host = explicit.host + ':' + explicit.port
    return { host, reachable: true, reason: null, candidates: [host] }
  }
  const candidateAddresses = addresses ?? localAddressCandidates()
  const candidates = candidateAddresses.map((item) =>
    (typeof item === 'string' ? item : item.address) + ':' + port
  )
  if (LOOPBACK_LISTEN.has(listen)) {
    return { host: null, reachable: false, reason: 'loopback', candidates: [] }
  }
  const wildcard = listen === '0.0.0.0' || listen === '::' || listen === '' || listen === '*'
  // 监听在具体地址（不是通配）：它就是唯一正确的答案
  if (!wildcard && /^[0-9.]+$/.test(listen)) {
    const host = listen + ':' + port
    return { host, reachable: true, reason: null, candidates: [host] }
  }
  if (candidates.length === 0) {
    return { host: null, reachable: false, reason: 'no-address', candidates: [] }
  }
  return { host: candidates[0], reachable: true, reason: null, candidates }
}

/**
 * 组装配对串。
 *
 * @param {object} input
 * @param input.host host:port（一般直接来自 resolvePairTarget().host）
 * @param input.code 8 位配对码明文
 * @param input.fingerprint 证书指纹（规范格式）；null/空串表示明文服务，串里不带 f
 * @param input.expiresAt 过期时间（毫秒时间戳）；null 时不带 x
 * @returns {string} deepseek-sync://pair?v=1&h=...&c=...[&f=...][&x=...]
 * @throws host / code / fingerprint 不合法时抛错（这些都是服务端自己的值，错了要当场炸）
 */
export function buildPairUri({ host, code, fingerprint = null, expiresAt = null }) {
  const target = normalizePairHost(host, PAIR_DEFAULT_PORT)
  if (!target) throw new Error('配对串的 host 不合法：' + String(host))
  const normalizedCode = String(code ?? '').trim().toUpperCase()
  if (!PAIR_CODE_PATTERN.test(normalizedCode)) {
    throw new Error('配对串的 code 不合法：' + String(code))
  }
  const parts = [
    'v=' + PAIR_VERSION,
    'h=' + target.host + ':' + target.port,
    'c=' + normalizedCode,
  ]
  if (fingerprint) {
    const normalized = normalizeCertFingerprint(fingerprint)
    if (!normalized) throw new Error('配对串的证书指纹不合法：' + String(fingerprint))
    parts.push('f=' + normalized)
  }
  if (expiresAt !== null && expiresAt !== undefined) {
    const seconds = Math.floor(Number(expiresAt) / 1000)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error('配对串的过期时间不合法：' + String(expiresAt))
    }
    parts.push('x=' + seconds)
  }
  return PAIR_SCHEME + '://' + PAIR_HOST + '?' + parts.join('&')
}

/**
 * 解析配对串（工具/对拍用；页面侧那份在 src/services/sync/pairing.ts，规则逐条对应）。
 *
 * 只做「格式与字段」的判断，不发网络请求、不看时间是否过期（x 过期由调用方决定怎么说），
 * 也不决定用 https 还是 http —— 那是客户端按 f 是否存在来定的。
 *
 * @param raw 扫码/粘贴得到的原始串
 * @returns {{ ok: true, version: string, host: string, port: number, code: string,
 *             fingerprint: string | null, expiresAt: number | null }
 *           | { ok: false, reason: 'scheme' | 'version' | 'host' | 'code' | 'fingerprint' }}
 */
export function parsePairUri(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'scheme' }
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'scheme' }
  }
  if (url.protocol !== PAIR_SCHEME + ':') return { ok: false, reason: 'scheme' }
  // 坑 1：自定义 scheme 的 hostname 不自动小写
  if (url.hostname.toLowerCase() !== PAIR_HOST) return { ok: false, reason: 'scheme' }
  // 坑 2：pathname 可能是 '/'，一律忽略 —— 不要断言它为空
  const params = url.searchParams
  if (params.get('v') !== PAIR_VERSION) return { ok: false, reason: 'version' }
  const hostRaw = params.get('h') ?? ''
  // 显式排掉方括号：v1 不支持 IPv6 字面量
  if (!PAIR_HOST_PATTERN.test(hostRaw) || hostRaw.includes('[')) {
    return { ok: false, reason: 'host' }
  }
  const target = normalizePairHost(hostRaw, PAIR_DEFAULT_PORT)
  if (!target) return { ok: false, reason: 'host' }
  const code = (params.get('c') ?? '').trim().toUpperCase()
  if (!PAIR_CODE_PATTERN.test(code)) return { ok: false, reason: 'code' }
  const fingerprintRaw = params.get('f')
  let fingerprint = null
  if (fingerprintRaw !== null) {
    fingerprint = normalizeCertFingerprint(fingerprintRaw)
    if (!fingerprint) return { ok: false, reason: 'fingerprint' }
  }
  const expiresRaw = params.get('x')
  let expiresAt = null
  if (expiresRaw !== null) {
    const seconds = Number(expiresRaw)
    if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: 'host' }
    expiresAt = Math.floor(seconds) * 1000
  }
  return { ok: true, version: PAIR_VERSION, host: target.host, port: target.port, code, fingerprint, expiresAt }
}
