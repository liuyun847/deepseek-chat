/**
 * 自签证书指纹固定（HTTPS 同步）在页面侧的入口。
 *
 * 为什么要有这一层
 * ================
 * 同步服务用自签证书时，WebView 会在 TLS 阶段就拒绝连接（network_security_config.xml 已禁明文，
 * 且不允许 TOFU）。唯一能放行的点在主进程：MainActivity.onReceivedSslError 只有在
 * 「本机固定过该证书的 SHA-256」时才 handler.proceed()，否则 handler.cancel()。
 * 于是页面必须能把指纹交给原生，这件事只能走桥：
 *
 *   page ──► window.__dsSync.setTlsPin(指纹)          （android/shell/shell.js 注入的 shim）
 *        ──► window.__DS_BRIDGE__.setSyncTlsPin()      （MainActivity.Bridge，写 SharedPreferences）
 *        ──► onReceivedSslError 读持久化的 pin 比对证书   （进程重启后仍然有效）
 *
 * 网页/浏览器里没有这两层，所有函数都退化成「不可用 + 空串」，**静默不做任何事**：
 * 浏览器场景由本机服务（local-server，走 SYNC_CA_FILE 校验）或浏览器自己的信任链负责，
 * 页面不需要也不该在这里报错。
 *
 * 指纹格式全仓唯一：64 位小写十六进制、无分隔符。
 * 服务端算它的实现在 sync-server/cert-fingerprint.mjs，原生校验在 MainActivity（会先去掉
 * 冒号与空格再按 [0-9a-f]{64} 比对），三处对同一张证书必须得出同一串。
 */

/** 规范格式：64 位小写十六进制、无分隔符 */
export const CERT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

/** 壳层 shim（android/shell/shell.js 注入的 window.__dsSync） */
type SyncTlsShim = {
  available: boolean
  /** 当前固定的指纹（规范格式）；没固定时空串 */
  getTlsPin(): string
  /** 固定或清除（空串 = 清除）；返回 false 表示没有桥或输入不合法 */
  setTlsPin(fingerprint: string): boolean
}

/**
 * 原生桥上的两个方法。
 * 只声明用得到的那两个：桥对象是壳注入的，类型不必（也不该）在这里穷举。
 */
type SyncTlsNativeBridge = {
  setSyncTlsPin?(fingerprint: string): void
  getSyncTlsPin?(): string
}

declare global {
  interface Window {
    /** 安卓壳注入的指纹桥；浏览器里不存在 */
    __dsSync?: SyncTlsShim
    /**
     * 安卓壳注入的原生桥（MainActivity.Bridge）；浏览器里不存在。
     *
     * 声明放在这里而不是各使用点：同一个全局对象被多个文件各声明一次，TS 会判成
     * 「同名属性类型冲突」（TS2717）。这里只声明同步侧用得到的那几个方法，不穷举。
     */
    __DS_BRIDGE__?: SyncTlsNativeBridge & { platform?: () => string }
  }
}

/**
 * 把任意写法的指纹收敛成规范格式。
 *
 * 接受 OpenSSL 的 `AB:CD:…` 大写冒号写法、空格分组、全小写无分隔；其余字符一律丢掉再看结果。
 * 与服务端 normalizeCertFingerprint 同一套规则（见 sync-server/cert-fingerprint.mjs）。
 *
 * @param value 用户粘贴/接口返回的任意写法
 * @returns 64 位小写十六进制；不合法时空串
 */
export const normalizeCertFingerprint = (value: unknown): string => {
  if (typeof value !== 'string') {
    return ''
  }
  const compact = value.replace(/[^0-9a-zA-Z]/g, '').toLowerCase()
  return CERT_FINGERPRINT_PATTERN.test(compact) ? compact : ''
}

/**
 * 是否是合法的指纹写法。
 * @param value 任意值
 * @returns 收敛成规范格式后是否合法
 */
export const isCertFingerprint = (value: unknown): boolean =>
  normalizeCertFingerprint(value) !== ''

/** 壳层 shim；浏览器里为 null */
const shim = (): SyncTlsShim | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const value = window.__dsSync
  return value && value.available === true ? value : null
}

/** 原生桥（壳层没注入 shim 时的兜底通道）；浏览器里为 null */
const nativeBridge = (): SyncTlsNativeBridge | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const bridge = window.__DS_BRIDGE__ as SyncTlsNativeBridge | undefined
  return bridge && typeof bridge.setSyncTlsPin === 'function' ? bridge : null
}

/**
 * 本环境能不能把指纹固定到原生层。
 *
 * @returns 安卓壳里 true，浏览器里 false（界面据此隐藏「固定到本机」这类按钮）
 */
export const syncTlsPinAvailable = (): boolean => shim() !== null || nativeBridge() !== null

/**
 * 读本机已固定的指纹。
 *
 * @returns 规范格式的指纹；浏览器里、或还没固定时返回空串（不抛错）
 */
export const readSyncTlsPin = (): string => {
  const layer = shim()
  if (layer) {
    try {
      return normalizeCertFingerprint(layer.getTlsPin())
    } catch {
      return ''
    }
  }
  const bridge = nativeBridge()
  if (bridge && typeof bridge.getSyncTlsPin === 'function') {
    try {
      return normalizeCertFingerprint(bridge.getSyncTlsPin())
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * 固定（或清除）本机指纹。
 *
 * @param fingerprint 指纹，任意写法；空串表示清除
 * @returns 是否写入成功；浏览器里恒为 false（静默跳过，不抛错）
 */
export const writeSyncTlsPin = (fingerprint: string): boolean => {
  const value = normalizeCertFingerprint(fingerprint)
  // 输入非空但不是合法指纹：不写，让界面提示格式不对（不能悄悄当成「清除」）
  if (!value && fingerprint.trim() !== '') {
    return false
  }
  const layer = shim()
  if (layer) {
    try {
      return layer.setTlsPin(value)
    } catch {
      return false
    }
  }
  const bridge = nativeBridge()
  if (bridge) {
    try {
      bridge.setSyncTlsPin?.(value)
      return true
    } catch {
      return false
    }
  }
  return false
}
