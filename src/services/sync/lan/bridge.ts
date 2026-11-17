import { isCryptoAvailable } from './crypto.js'

/**
 * 原生桥（ds.app.MainActivity.Bridge 的 lan* 方法）与壳层 shim（android/shell/shell.js 的
 * window.__dsLan）在 TypeScript 侧的封装。
 *
 * 为什么分成两层
 * ============
 *   原生：只搬字节。lanStart / lanStop / lanPeers / lanSend / lanReply / lanTake。
 *   shim：把「异步回调 + 同步取数据」拼成 Promise，并处理「页面还没注册处理器时请求先到了」
 *         这段竞态（见 shell.js 的 lanQueue）。
 * 本文件只做类型与少量校验，不做重试与合并。
 */

/** 原生自报的本机信息 */
export type LanSelf = {
  deviceId: string
  name: string
  port: number
  host: string
  pairTag: string
  udpPort: number
}

/** 原生对端表里的一台设备 */
export type LanPeerInfo = {
  deviceId: string
  name: string
  host: string
  port: number
  pairTag: string
  lastSeen: number
}

/** 原生桥中与局域网相关的方法（其余方法本项目不用，故意不声明） */
type LanNativeBridge = {
  lanStart(deviceId: string, deviceName: string, pairTag: string): string
  lanStop(): void
  lanPeers(): string
  lanTake(requestId: string): string | null
  lanSend(requestId: string, host: string, port: number, payload: string): void
  lanReply(requestId: string, payload: string): boolean
  lanAddress(): string
}

/** 收件箱返回的结构（LanLink.take） */
type LanTaken = { ok: boolean; payload?: string; error?: string }

/** 页面侧的处理器 */
export type LanHandlers = {
  /** 在线设备表变了 */
  onPeers(): void
  /** 收到一个请求，参数用 take() 取 */
  onRequest(requestId: string): void
}

/** 壳层 shim（shell.js 注入的 window.__dsLan） */
type LanShim = {
  available: boolean
  listen(handlers: LanHandlers): void
  send(id: string, host: string, port: number, payload: string, timeoutMs?: number): Promise<string>
}

declare global {
  interface Window {
    /** 安卓壳注入的原生桥；浏览器里不存在 */
    __DS_BRIDGE__?: Partial<LanNativeBridge> & { platform?: () => string }
    /** 壳层 shim；浏览器里不存在 */
    __dsLan?: LanShim
  }
}

/** 局域网相关的可预期错误；界面按 code 出文案 */
export class LanError extends Error {
  readonly code: string

  constructor(code: string, detail?: string) {
    super(detail ?? code)
    this.name = 'LanError'
    this.code = code
  }
}

const nativeBridge = (): LanNativeBridge | null => {
  const bridge = window.__DS_BRIDGE__
  if (!bridge || typeof bridge.lanStart !== 'function' || typeof bridge.lanTake !== 'function') {
    return null
  }
  return bridge as LanNativeBridge
}

const shim = (): LanShim | null => {
  const value = window.__dsLan
  return value && value.available ? value : null
}

/**
 * 当前环境能否用手机直连：既要原生桥（APK），也要 WebCrypto（加密）。
 * 网页形态下只有前者不满足，界面会显示「仅安卓壳支持」。
 */
export const lanAvailability = (): { native: boolean; crypto: boolean; ready: boolean } => {
  const native = nativeBridge() !== null && shim() !== null
  const crypto = isCryptoAvailable()
  return { native, crypto, ready: native && crypto }
}

/**
 * 启动监听与广播（幂等）。
 *
 * @param deviceId 本机设备 id（沿用多端同步那一个，冲突判定与记录里的 device 同源）
 * @param name 展示用设备名
 * @param pairTag 口令指纹；空串表示还没设口令
 * @returns 本机信息
 * @throws LanError code 为 bridge（不是安卓壳）或 start（原生起不来）
 */
export const startNative = (deviceId: string, name: string, pairTag: string): LanSelf => {
  const bridge = nativeBridge()
  if (!bridge) {
    throw new LanError('bridge')
  }
  const text = bridge.lanStart(deviceId, name, pairTag)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new LanError('start', text.slice(0, 120))
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new LanError('start', text.slice(0, 120))
  }
  const source = parsed as Record<string, unknown>
  if (typeof source.error === 'string') {
    throw new LanError('start', source.error)
  }
  return {
    deviceId: typeof source.deviceId === 'string' ? source.deviceId : deviceId,
    name: typeof source.name === 'string' ? source.name : name,
    port: typeof source.port === 'number' ? source.port : 0,
    host: typeof source.host === 'string' ? source.host : '127.0.0.1',
    pairTag: typeof source.pairTag === 'string' ? source.pairTag : pairTag,
    udpPort: typeof source.udpPort === 'number' ? source.udpPort : 0,
  }
}

export const stopNative = (): void => {
  nativeBridge()?.lanStop()
}

/**
 * 读在线设备表。
 *
 * @returns 原生给的设备表；不是安卓壳或解析失败时返回空数组
 */
export const readPeers = (): LanPeerInfo[] => {
  const bridge = nativeBridge()
  if (!bridge) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bridge.lanPeers())
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const peers: LanPeerInfo[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const source = item as Record<string, unknown>
    if (typeof source.deviceId !== 'string' || typeof source.host !== 'string') {
      continue
    }
    peers.push({
      deviceId: source.deviceId,
      name: typeof source.name === 'string' ? source.name : source.deviceId,
      host: source.host,
      port: typeof source.port === 'number' ? source.port : 0,
      pairTag: typeof source.pairTag === 'string' ? source.pairTag : '',
      lastSeen: typeof source.lastSeen === 'number' ? source.lastSeen : 0,
    })
  }
  return peers
}

/**
 * 取走一条收件箱数据。
 *
 * @param requestId onRequest 给的那个 id
 * @returns 数据；已被取走或桥不在时返回 null
 */
export const takeInbox = (requestId: string): LanTaken | null => {
  const bridge = nativeBridge()
  if (!bridge) {
    return null
  }
  const raw = bridge.lanTake(requestId)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      ok: parsed.ok === true,
      payload: typeof parsed.payload === 'string' ? parsed.payload : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    }
  } catch {
    return null
  }
}

/**
 * 回一个请求。
 *
 * @param requestId onRequest 给的那个 id
 * @param payload 信封 JSON
 * @returns 原生是否还认这个请求（false 表示已超时，对端收不到回复）
 */
export const replyNative = (requestId: string, payload: string): boolean => {
  const bridge = nativeBridge()
  return bridge ? bridge.lanReply(requestId, payload) : false
}

/**
 * 发一个请求并等回复。
 *
 * @param requestId 请求 id（同时用于信封 AAD）
 * @param host 对端地址
 * @param port 对端端口
 * @param payload 信封 JSON
 * @returns 回复的信封原文
 * @throws LanError code 为 bridge / timeout / network
 */
export const sendNative = async (
  requestId: string,
  host: string,
  port: number,
  payload: string
): Promise<string> => {
  const value = shim()
  if (!value) {
    throw new LanError('bridge')
  }
  try {
    return await value.send(requestId, host, port, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'timeout') {
      throw new LanError('timeout')
    }
    throw new LanError('network', message)
  }
}

/** 注册页面侧处理器（可重复调用，后一次覆盖前一次） */
export const installHandlers = (handlers: LanHandlers): boolean => {
  const value = shim()
  if (!value) {
    return false
  }
  value.listen(handlers)
  return true
}
