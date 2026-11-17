/**
 * 加密信封的封装与拆封：把 lan/crypto.ts 与 lan/protocol.ts 的编译产物接起来。
 *
 * 分层（与手机端完全一致，一行协议都没改）：
 *   TCP 裸字节 → 4 字节大端长度 + 信封 JSON（明文路由元数据）
 *     → 信封里的 data = base64(gzip(AES-GCM(消息 JSON)))
 *       → 消息 = hello / sync / sync-reply / ping
 *
 * 这里负责的还是那三件事：派生密钥、封包、拆包（含重放去重与失败分类），
 * 判定与合并逻辑一律留在编译产物里，不在这里重写一份。
 */
import { LAN_FORMAT, LAN_MAX_BYTES, LAN_PROTO, createRequestId, envelopeAad, parseEnvelope, parseMessage } from './build/src/services/sync/lan/protocol.js'
import { LanCryptoError, deriveKeyBytes, importLanKey, openMessage, pairTagOf, sealMessage } from './build/src/services/sync/lan/crypto.js'

/** 记住多少个已处理的请求 id（手机端是 64，这里放宽到 256：电脑端连接更密） */
const SEEN_LIMIT = 256

/** 收包体积上限：信封是 base64，32 MB 明文对应到信封约 43 MB，与 Java 侧 40 MB 同量级取 48 MB */
const MAX_ENVELOPE_BYTES = LAN_MAX_BYTES * 1.5

/**
 * 造一个编解码器。
 *
 * @param {{ passphrase: string, deviceId: string, log: object }} options
 * @returns {Promise<{ pairTag: string, seal: Function, open: Function, deviceId: string }>}
 * @sideeffect PBKDF2 12 万轮，约几十毫秒（Node 上实测 < 100 ms）
 */
export const createCodec = async (options) => {
  const deviceId = options.deviceId
  const keyBytes = await deriveKeyBytes(options.passphrase)
  const key = await importLanKey(keyBytes)
  const pairTag = await pairTagOf(keyBytes)
  /** 重放去重：id → 首次见到的时间（保持插入序，超限淘汰最旧的） */
  const seen = new Map()

  const rememberSeen = (id) => {
    seen.set(id, Date.now())
    while (seen.size > SEEN_LIMIT) {
      const first = seen.keys().next()
      if (first.done === true) {
        break
      }
      seen.delete(first.value)
    }
  }

  /**
   * 把一条消息封成信封 JSON。
   *
   * @param {object} message hello / sync / sync-reply / ping
   * @returns {Promise<string>} 可以直接写进 TCP 帧的 JSON 文本
   * @throws {LanCryptoError} code 为 too-large（压缩后仍超 32 MB）
   */
  const seal = async (message) => {
    const id = createRequestId()
    const ts = Date.now()
    const sealed = await sealMessage(key, envelopeAad({ from: deviceId, id, ts }), message)
    return JSON.stringify({
      format: LAN_FORMAT,
      proto: LAN_PROTO,
      from: deviceId,
      id,
      ts,
      iv: sealed.iv,
      data: sealed.data,
    })
  }

  /**
   * 拆一个信封：体积 → JSON → 信封结构/时间窗口 → 重放 → 解密（GCM 校验）→ 消息结构。
   *
   * @param {string} text 收到的信封 JSON 原文
   * @returns {Promise<{ ok: true, envelope: object, message: object }
   *   | { ok: false, reason: string, from?: string, detail?: string }>}
   *   reason 取值：too-large / format / replay / auth / unknown-message
   */
  const open = async (text) => {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, reason: 'format', detail: '空正文' }
    }
    if (text.length > MAX_ENVELOPE_BYTES) {
      return { ok: false, reason: 'too-large', detail: 'text=' + text.length }
    }
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return { ok: false, reason: 'format', detail: '不是合法 JSON' }
    }
    const envelope = parseEnvelope(parsed, Date.now())
    if (!envelope) {
      // 格式 / proto 版本 / 时间窗口（±120 秒）任一不符都会走到这里
      const shape = parsed && typeof parsed === 'object' ? parsed : {}
      return {
        ok: false,
        reason: 'format',
        from: typeof shape.from === 'string' ? shape.from : undefined,
        detail: 'format=' + String(shape.format) + ' proto=' + String(shape.proto) + ' ts=' + String(shape.ts),
      }
    }
    if (envelope.from !== deviceId && seen.has(envelope.id)) {
      return { ok: false, reason: 'replay', from: envelope.from, detail: 'id=' + envelope.id }
    }
    rememberSeen(envelope.id)
    let body = null
    try {
      body = await openMessage(key, envelopeAad(envelope), { iv: envelope.iv, data: envelope.data })
    } catch (error) {
      const code = error instanceof LanCryptoError ? error.code : 'format'
      // auth = GCM 校验失败 = 口令不一致（或信封元数据被改）
      return { ok: false, reason: code === 'auth' ? 'auth' : 'format', from: envelope.from }
    }
    const message = parseMessage(body)
    if (!message) {
      return { ok: false, reason: 'unknown-message', from: envelope.from }
    }
    return { ok: true, envelope, message }
  }

  return { deviceId, pairTag, seal, open }
}
