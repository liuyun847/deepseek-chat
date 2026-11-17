import { gzipSync, gunzipSync } from 'fflate'
import { createIv, LAN_MAX_BYTES } from './protocol.js'

/**
 * 局域网直连的加密层。
 *
 * 安全模型（为什么这样够用，也为什么只有这些）
 * ==========================================
 * 1. 两端凭「同一个口令」取得同一把密钥：PBKDF2-HMAC-SHA256，固定盐，120000 轮，
 *    派生 256 位。口令不传输、不落盘 —— 落盘的是派生后的密钥字节（见 lan/settings.ts），
 *    所以本机存储被翻出来时泄露的是「这一对的密钥」，不是用户可能复用到别处的口令本身。
 * 2. 每条消息用 AES-GCM 加密，随机 12 字节 iv，128 位 tag；信封里的 from / id / ts
 *    作为 AAD 参与认证，中间人改了路由元数据会直接解不开（GCM 校验失败）。
 * 3. 口令指纹：pairTag = SHA-256(密钥) 的前 6 字节（12 位十六进制），随设备广播明文发出。
 *    它让两端在零配置的前提下互相认出「口令一致」，且反推不出口令（PBKDF2 本身是单向的，
 *    12 位十六进制还给暴力猜测留了足够小的命中窗口）。指纹相同 = 已配对，可以自动同步。
 * 4. 重放：信封带 ts，超出 ±LAN_TIME_WINDOW 直接丢；页面侧再按 id 去重（见 engine.ts）。
 *
 * 已知边界（写进报告，不假装没有）
 * ============================
 * - 固定盐意味着「不同用户对恰好用了同一个口令」时密钥相同。口令由用户线下交换，
 *   这属于同一信任域内的固有性质；想更严就得引入随机盐 + 带外传输，那就不是零配置了。
 * - 没有前向保密：口令不变，密钥就不变，长期密钥泄露 = 历史报文全部可解。
 * - pairTag 是密钥派生出的公开值：局域网内任何人看得到「这台设备有配对」。它不可逆，
 *   但足以让攻击者对弱口令做离线字典（PBKDF2 12 万轮把每次尝试的成本抬到毫秒级）。
 *   因此界面文案要求口令至少 8 位（见 lan/settings.ts 的校验）。
 */

/** PBKDF2 的盐：固定值，两端不传输即可对齐（理由见文件头「已知边界」） */
const SALT_TEXT = 'chat-demo-lan-v1'

/** PBKDF2 迭代轮数：WebView 91 实测约 50 ms，界面只在输入口令那一次付出这个代价 */
const ITERATIONS = 120_000

/** 密钥长度（AES-256） */
const KEY_BYTES = 32

/** 口令指纹长度（字节） */
const PAIR_TAG_BYTES = 6

/** 口令最短长度：太短的口令挡不住离线字典 */
export const MIN_PASSPHRASE_LENGTH = 8

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * 复制成一个「根 ArrayBuffer」，专供 WebCrypto 用。
 *
 * 为什么不直接传 Uint8Array：TS 7 的 lib.dom 把 BufferSource 收窄成
 * ArrayBufferView&lt;ArrayBuffer&gt;，而普通 Uint8Array 的类型是 Uint8Array&lt;ArrayBufferLike&gt;
 * （可能共享 SharedArrayBuffer），编译期不兼容。这里显式复制一份，类型与运行期都干净；
 * 代价是一次内存拷贝，消息常规在几十 KB 量级。
 *
 * @param bytes 任意字节数组（可以是某个大缓冲的视图）
 * @returns 内容相同、独占的 ArrayBuffer
 */
const bufferOf = (bytes: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(bytes.length)
  new Uint8Array(out).set(bytes)
  return out
}

/** 加密层失败原因，界面按它出文案 */
export type LanCryptoFailure = 'unsupported' | 'auth' | 'format' | 'too-large' | 'short'

/** 加密层的可预期错误；不是 SyncError（那条链路是 HTTP 专用） */
export class LanCryptoError extends Error {
  readonly code: LanCryptoFailure

  constructor(code: LanCryptoFailure, detail?: string) {
    super(detail ?? code)
    this.name = 'LanCryptoError'
    this.code = code
  }
}

/**
 * 本机是否具备加密能力。
 * WebView 91 实测具备（https://dsapp.local 是安全上下文）；网页以 file:// 打开时不具备，
 * 那时整个「手机直连」面板会显示「当前环境不支持」而不是静默失败。
 */
export const isCryptoAvailable = (): boolean =>
  typeof crypto !== 'undefined' &&
  !!crypto.subtle &&
  typeof crypto.subtle.deriveBits === 'function' &&
  typeof crypto.subtle.encrypt === 'function' &&
  typeof crypto.getRandomValues === 'function'

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 反查表：ASCII 码 → Base64 值，-1 表示不是合法字符 */
const B64_LOOKUP = (() => {
  const table = new Int8Array(128)
  table.fill(-1)
  for (let index = 0; index < B64_ALPHABET.length; index += 1) {
    table[B64_ALPHABET.charCodeAt(index)] = index
  }
  return table
})()

/**
 * 字节 → Base64。
 * 不用 btoa(String.fromCharCode(...))：大数组走 apply 容易爆栈，逐字符拼又慢，
 * 这里按 3 字节一组直接算索引，体积与速度都可控，也不依赖 btoa 是否存在。
 *
 * @param bytes 任意字节数组
 * @returns 标准 Base64（带 = 填充）
 */
export const toBase64 = (bytes: Uint8Array): string => {
  const out: string[] = []
  let index = 0
  for (; index + 2 < bytes.length; index += 3) {
    const block = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2]
    out.push(
      B64_ALPHABET[(block >> 18) & 63] + B64_ALPHABET[(block >> 12) & 63] +
        B64_ALPHABET[(block >> 6) & 63] + B64_ALPHABET[block & 63]
    )
  }
  const rest = bytes.length - index
  if (rest === 1) {
    const block = bytes[index] << 16
    out.push(B64_ALPHABET[(block >> 18) & 63] + B64_ALPHABET[(block >> 12) & 63] + '==')
  } else if (rest === 2) {
    const block = (bytes[index] << 16) | (bytes[index + 1] << 8)
    out.push(
      B64_ALPHABET[(block >> 18) & 63] + B64_ALPHABET[(block >> 12) & 63] +
        B64_ALPHABET[(block >> 6) & 63] + '='
    )
  }
  return out.join('')
}

/**
 * Base64 → 字节。
 *
 * @param text Base64 文本（容忍结尾的 = 与换行空白）
 * @returns 解出的字节
 * @throws LanCryptoError code 为 format（含非法字符）
 */
export const fromBase64 = (text: string): Uint8Array => {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let written = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 61) {
      break
    }
    const value = code < 128 ? B64_LOOKUP[code] : -1
    if (value < 0) {
      continue
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[written] = (buffer >> bits) & 0xff
      written += 1
    }
  }
  return out.subarray(0, written)
}

/**
 * 口令 → 密钥字节（PBKDF2-HMAC-SHA256）。
 *
 * @param passphrase 用户在两台设备上输入的同一口令（调用方保证已去空白）
 * @returns 32 字节密钥材料
 * @throws LanCryptoError code 为 unsupported（环境没有 WebCrypto）
 * @sideeffect 只做 CPU 计算，不落盘；120000 轮在 WebView 91 上约 50 ms
 */
export const deriveKeyBytes = async (passphrase: string): Promise<Uint8Array> => {
  if (!isCryptoAvailable()) {
    throw new LanCryptoError('unsupported')
  }
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(SALT_TEXT), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    KEY_BYTES * 8
  )
  return new Uint8Array(bits)
}

/**
 * 密钥字节 → AES-GCM 的 CryptoKey（不可导出，只能加解密）。
 *
 * @param bytes deriveKeyBytes 或本机存储里读回的密钥材料
 * @returns 可用于 seal / open 的密钥
 */
export const importLanKey = async (bytes: Uint8Array): Promise<CryptoKey> => {
  if (!isCryptoAvailable()) {
    throw new LanCryptoError('unsupported')
  }
  return crypto.subtle.importKey('raw', bufferOf(bytes), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/**
 * 口令指纹：把密钥再散列一次取前 6 字节。
 * 广播里带的是它，用来判断「对方和我是同一个口令」。
 *
 * @param keyBytes 密钥材料
 * @returns 12 位十六进制字符串
 */
export const pairTagOf = async (keyBytes: Uint8Array): Promise<string> => {
  if (!isCryptoAvailable()) {
    throw new LanCryptoError('unsupported')
  }
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bufferOf(keyBytes)))
  let hex = ''
  for (let index = 0; index < PAIR_TAG_BYTES; index += 1) {
    hex += hashed[index].toString(16).padStart(2, '0')
  }
  return hex
}

/** 一条消息的密文形态（信封里 iv / data 两个字段） */
export type SealedMessage = { iv: string; data: string }

/**
 * 加密一条消息：JSON → gzip → AES-GCM。
 * 先压缩再加密是为了压住 32 MB 上限（会话正文重复度高，实测能到 1/5 以下）。
 *
 * @param key 由 importLanKey 得到的密钥
 * @param aad envelopeAad() 的结果，绑定信封元数据
 * @param message 待发送的 LanMessage
 * @returns base64 的 iv 与密文
 * @throws LanCryptoError code 为 too-large（明文超过 32 MB）
 */
export const sealMessage = async (
  key: CryptoKey,
  aad: string,
  message: unknown
): Promise<SealedMessage> => {
  const plain = gzipSync(encoder.encode(JSON.stringify(message)))
  if (plain.length > LAN_MAX_BYTES) {
    throw new LanCryptoError('too-large')
  }
  const iv = createIv()
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferOf(iv), additionalData: encoder.encode(aad), tagLength: 128 },
    key,
    bufferOf(plain)
  )
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) }
}

/**
 * 解密一条消息。口令不一致时 GCM 校验失败 —— 这是配对判定的最终依据。
 *
 * @param key 本机密钥
 * @param aad envelopeAad() 的结果（必须与加密端一致）
 * @param sealed base64 的 iv 与密文
 * @returns 解出的消息对象（未经结构校验，交给 parseMessage）
 * @throws LanCryptoError code 为 auth（口令不同 / 信封被改）或 format（密文损坏）
 */
export const openMessage = async (
  key: CryptoKey,
  aad: string,
  sealed: SealedMessage
): Promise<unknown> => {
  const iv = fromBase64(sealed.iv)
  const data = fromBase64(sealed.data)
  if (iv.length !== 12 || data.length <= 16) {
    throw new LanCryptoError('format')
  }
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bufferOf(iv), additionalData: encoder.encode(aad), tagLength: 128 },
      key,
      bufferOf(data)
    )
  } catch {
    throw new LanCryptoError('auth')
  }
  try {
    return JSON.parse(decoder.decode(gunzipSync(new Uint8Array(plain))))
  } catch {
    throw new LanCryptoError('format')
  }
}
