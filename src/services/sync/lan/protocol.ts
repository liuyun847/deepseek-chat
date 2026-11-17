import { createId } from '../../../utils/id.js'
import { digest, normalizeRecord, recordKey, type SyncRecord } from '../protocol.js'

/**
 * 局域网手机直连的线上协议。
 *
 * 与 HTTP 通道的关系
 * =================
 * 记录结构、合并规则、墓碑语义全部复用 ../protocol.ts 与 ../merge.ts，这里只定义
 * 「两台手机之间怎么把记录搬过去」——外层信封（明文，含路由所需的最小元数据）与
 * 内层消息（密文，AES-GCM）。HTTP 通道（api.ts + sync-server）原样保留，互不影响。
 *
 * 分层
 * ====
 *   TCP 裸字节
 *     └─ 信封 JSON（LAN_FORMAT / proto / from / id / ts / iv / data）← 本文件
 *          └─ gzip(AES-GCM(消息 JSON))                          ← crypto.ts
 *               └─ LanMessage（hello / sync / sync-reply / ping） ← 本文件
 *                    └─ SyncRecord[]                             ← ../protocol.ts
 *
 * 为什么信封不加密：接收方要先知道「这是谁发的、用哪个 id 回」才能派发；iv 也必须明文
 * 才能解。信封里只有设备 id、随机请求 id、时间戳与随机 iv —— 都是派生不出密钥的公开量。
 * 真正的数据（会话标题、消息正文）在 data 里，没有口令解不开。
 */

/** 协议标识：两端必须一致，避免把别的服务当成同步对端 */
export const LAN_FORMAT = 'chat-demo-lan'

/** 协议版本；信封结构或消息类型改了就要 +1 */
export const LAN_PROTO = 1

/** 单条消息的明文字节上限（与 HTTP 通道的 32 MB 对齐） */
export const LAN_MAX_BYTES = 32 * 1024 * 1024

/** 允许的时钟偏差；超出窗口的信封直接丢弃（抑制重放） */
export const LAN_TIME_WINDOW = 120_000

/** 信封：TCP 上传输的完整 JSON 对象，字段全部明文 */
export type LanEnvelope = {
  format: string
  proto: number
  /** 发送方设备 id（与记录里的 device 字段同源） */
  from: string
  /** 本次请求的随机 id，回复时原样带回，用于在两端的挂起表里对上号 */
  id: string
  /** 发送时刻（毫秒） */
  ts: number
  /** AES-GCM 初始化向量，base64（12 字节） */
  iv: string
  /** 密文（末尾 16 字节是 GCM tag），base64 */
  data: string
}

/** 消息里带的本地规模，只用于界面展示「对方有多少数据」 */
export type LanStats = { records: number; sessions: number; messages: number }

/**
 * 一方的数据版本指纹：所有记录的「主键@时间#设备」排序后取 digest。
 * 两端相同即代表「逐条版本完全一致」，可以跳过整轮同步 —— 这是自动同步不打扰用户的依据。
 */
export type LanHello = {
  t: 'hello'
  device: string
  name: string
  stamp: string
  stats: LanStats
}

/** 推送本地记录，请求对方合并后回复差异（只回对方赢或缺失的那些） */
export type LanSyncRequest = {
  t: 'sync'
  device: string
  name: string
  records: SyncRecord[]
}

/** 合并结果：records 是「请求方需要落地的记录」，为空中省略 */
export type LanSyncReply = {
  t: 'sync-reply'
  device: string
  name: string
  records: SyncRecord[]
  /** 收到多少条 */
  received: number
  /** 其中本地落地了多少条 */
  applied: number
}

/** 探活（界面上的「测试连接」，不传数据） */
export type LanPing = { t: 'ping'; device: string; name: string }

export type LanMessage = LanHello | LanSyncRequest | LanSyncReply | LanPing

/** 新请求 id（时间前缀便于日志排查，后半段随机保证唯一） */
export const createRequestId = (): string => Date.now().toString(36) + '-' + createId().replace(/-/g, '').slice(0, 8)

/** 生成一个 12 字节随机 iv */
export const createIv = (): Uint8Array => {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  return iv
}

/**
 * AES-GCM 的附加认证数据：把信封里那几个明文元数据绑进 GCM tag。
 * 没有它，中间人改 from / id / ts 不会被发现（改完密文仍能解开）。
 */
export const envelopeAad = (env: { from: string; id: string; ts: number }): string =>
  LAN_FORMAT + '|' + LAN_PROTO + '|' + env.from + '|' + env.id + '|' + env.ts

/**
 * 校验并规范化收到的信封。
 *
 * @param value JSON.parse 之后的任意值
 * @param now 当前时间（注入便于确定性验证）
 * @returns 合法信封；格式/版本/时间窗口不对返回 null
 */
export const parseEnvelope = (value: unknown, now: number): LanEnvelope | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const source = value as Record<string, unknown>
  if (source.format !== LAN_FORMAT) {
    return null
  }
  if (source.proto !== LAN_PROTO) {
    return null
  }
  const { from, id, ts, iv, data } = source
  if (typeof from !== 'string' || !from) {
    return null
  }
  if (typeof id !== 'string' || !id) {
    return null
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return null
  }
  // 时钟偏差过大的直接丢弃：本协议不指望机器对时，只挡「很久以前录下的包」
  if (Math.abs(now - ts) > LAN_TIME_WINDOW) {
    return null
  }
  if (typeof iv !== 'string' || typeof data !== 'string') {
    return null
  }
  return { format: LAN_FORMAT, proto: LAN_PROTO, from, id, ts, iv, data }
}

/** 记录表的数据版本指纹（两端一致即可跳过同步） */
export const stampOf = (records: Iterable<SyncRecord>): string => {
  const lines: string[] = []
  for (const record of records) {
    lines.push(recordKey(record.kind, record.id) + '@' + record.updatedAt + '#' + record.device)
  }
  lines.sort()
  return digest(lines)
}

/**
 * 一批记录的规模统计。
 * 只数会话与消息：设置、提示词、选中项混进 messages 会让界面上的「对方有多少数据」失真。
 */
export const statsOf = (records: Iterable<SyncRecord>): LanStats => {
  let sessions = 0
  let messages = 0
  for (const record of records) {
    if (record.deletedAt != null) {
      continue
    }
    if (record.kind === 'session') {
      sessions += 1
    } else if (record.kind === 'message') {
      messages += 1
    }
  }
  return { records: sessions + messages, sessions, messages }
}

/** 校验记录数组：不合法条目直接丢掉（与 api.ts 的 parseRecords 行为一致） */
const parseRecords = (value: unknown): SyncRecord[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const records: SyncRecord[] = []
  for (const item of value) {
    const record = normalizeRecord(item)
    if (record) {
      records.push(record)
    }
  }
  return records
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 校验并规范化解密后的消息。
 *
 * @param value 解密并 JSON.parse 之后的值
 * @returns 合法消息；不认识的消息类型返回 null（调用方回一条空响应，不崩）
 */
export const parseMessage = (value: unknown): LanMessage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const source = value as Record<string, unknown>
  const device = asString(source.device)
  const name = asString(source.name)
  if (!device) {
    return null
  }
  switch (source.t) {
    case 'hello': {
      const stats = source.stats
      const safe = stats && typeof stats === 'object' ? (stats as Record<string, unknown>) : {}
      return {
        t: 'hello',
        device,
        name,
        stamp: asString(source.stamp),
        stats: {
          records: typeof safe.records === 'number' ? safe.records : 0,
          sessions: typeof safe.sessions === 'number' ? safe.sessions : 0,
          messages: typeof safe.messages === 'number' ? safe.messages : 0,
        },
      }
    }
    case 'sync':
      return { t: 'sync', device, name, records: parseRecords(source.records) }
    case 'sync-reply':
      return {
        t: 'sync-reply',
        device,
        name,
        records: parseRecords(source.records),
        received: typeof source.received === 'number' ? source.received : 0,
        applied: typeof source.applied === 'number' ? source.applied : 0,
      }
    case 'ping':
      return { t: 'ping', device, name }
    default:
      return null
  }
}
