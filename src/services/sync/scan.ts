/**
 * 扫码配对的页面侧入口（安卓壳）：把「调起原生扫码界面、拿回原始串」包成一层 Promise。
 *
 * 为什么只回「原始串」而不是解析好的字段
 * ======================================
 * 解析器只有一份（src/services/sync/pairing.ts），并且能在 Node 里跑（tools/pair-qr-sim.mjs）。
 * 原生若自己解析，立刻会多出第二份 scheme / 字母表 / 字段规则 —— 两份规则迟早不一致。
 * 所以原生只负责「把像素变成字符串」，语义全在这一侧。
 *
 * 三层怎么套（与自签证书指纹那条链同构，见 tls.ts 文件头）：
 *
 *   page ──► window.__dsScan.start()            （android/shell/shell.js 注入的 shim）
 *        ──► window.__DS_BRIDGE__.startScan()    （MainActivity.Bridge，startActivityForResult）
 *        ──► ScanActivity                        （Camera2 预览 / 从图片选择）
 *        ◄── window.__dsScan.onResult(json)      （onActivityResult 里 evaluateJavascript 回传）
 *
 * 网页/浏览器里没有这两层，所有调用退化成「不可用」，**静默降级**：界面据此隐藏「扫码」按钮、
 * 只留「粘贴配对串」。这与 tls.ts 的处理方式一致，页面不必到处判运行形态。
 */

/** 原生回传的失败原因（与 ScanActivity 的 REASON_* 常量一一对应） */
export type ScanFailureReason =
  /** 这台设备没有可用的相机（模拟器无摄像头、或 uses-feature 声明为不需要） */
  | 'nocamera'
  /** 用户没给相机权限，且没有改用「从图片选择」 */
  | 'permission'
  /** 用户按了取消 / 返回键 */
  | 'cancelled'
  /** 连续 20 秒没扫到 */
  | 'timeout'
  /** 其他失败（打开相机出错等），detail 里带原始信息 */
  | 'error'
  /** 页面侧判定：没有原生桥（浏览器里） */
  | 'unavailable'

/** 一次扫码的结果 */
export type ScanResult =
  | { ok: true; raw: string }
  | { ok: false; reason: ScanFailureReason; detail?: string }

/** 壳层 shim（android/shell/shell.js 注入的 window.__dsScan） */
type ScanShim = {
  available: boolean
  /** 调起扫码界面；resolve 原生回传的对象（原样，不做语义判断） */
  start(): Promise<{ ok?: boolean; raw?: string; reason?: string; detail?: string }>
}

declare global {
  interface Window {
    /** 安卓壳注入的扫码桥；浏览器里不存在 */
    __dsScan?: ScanShim
  }
}

/** 已知的失败原因集合：原生给的字符串收窄成联合类型，不认识的按 error 处理 */
const KNOWN: readonly ScanFailureReason[] = [
  'nocamera',
  'permission',
  'cancelled',
  'timeout',
  'error',
  'unavailable',
]

/** 取壳层 shim；浏览器里为 null */
const shim = (): ScanShim | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const value = window.__dsScan
  return value && value.available === true ? value : null
}

/**
 * 本环境能不能调起原生扫码。
 *
 * @returns 安卓壳里 true，浏览器里 false（界面据此决定是否渲染「扫描二维码」按钮）
 */
export const scanAvailable = (): boolean => shim() !== null

/**
 * 调起原生扫码界面，等一串原始内容。
 *
 * 不抛异常：所有失败都折成 { ok:false, reason }，调用方按 reason 选文案。
 * 原生侧的「从图片选择」与相机在同一次调用里，所以「没相机」仍然可能带回一条串。
 *
 * @returns 成功带 raw（未经解析的原始串）；失败带 reason 与可选 detail
 */
export const startScan = async (): Promise<ScanResult> => {
  const layer = shim()
  if (!layer) {
    return { ok: false, reason: 'unavailable' }
  }
  let reply: Awaited<ReturnType<ScanShim['start']>>
  try {
    reply = await layer.start()
  } catch (error) {
    // shim 自己抛（桥调用异常、超时）都归到这里，detail 保留原始信息便于排查
    return {
      ok: false,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (reply && reply.ok === true && typeof reply.raw === 'string' && reply.raw.trim()) {
    return { ok: true, raw: reply.raw }
  }
  const reason = reply?.reason
  return {
    ok: false,
    reason: KNOWN.includes(reason as ScanFailureReason)
      ? (reason as ScanFailureReason)
      : 'error',
    detail: typeof reply?.detail === 'string' ? reply.detail : undefined,
  }
}
