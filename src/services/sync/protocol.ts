import type { Message } from '../chat/types.js'

/** 协议标识：客户端与服务端必须一致，否则拒绝（避免两套语义互相污染） */
export const SYNC_FORMAT = 'chat-demo-sync'
/** 协议版本；记录结构或合并规则改了就要 +1 */
export const SYNC_VERSION = 1
/** 单次推送的体积上限（32 MB），与服务端 MAX_BODY 一致 */
export const MAX_SYNC_BYTES = 32 * 1024 * 1024

/** 记录种类：会话（不含消息）与消息 */
export type SyncRecordKind = 'session' | 'message'

/**
 * 会话记录的 data：只放会话级字段。
 * messages 不在里面 —— 每条消息是独立记录，否则「A 改标题 + B 发消息」会整条互相覆盖。
 */
export type SessionRecordData = {
  id: string
  title: string
  createdAt: number
  /** 会话的更新时间，随消息活动变化；只用于展示与排序，不参与冲突判定（见 sessionDigestSource） */
  updatedAt: number
  /** undefined 表示线性消息列表；null 表示空会话 */
  rootMessageId?: string | null
}

/** 一条同步记录（线上格式） */
export type SyncRecord = {
  kind: SyncRecordKind
  id: string
  /** 消息记录所属会话；会话记录没有这个字段 */
  sessionId?: string
  /** 该记录内容最后一次变化的墙钟毫秒 */
  updatedAt: number
  /** 产生这一版内容的设备 id，仅用于 updatedAt 撞车时的 tie-break */
  device: string
  /** 非空即墓碑：内容已删除，data 置为 null */
  deletedAt?: number
  /** 墓碑为 null */
  data: SessionRecordData | Message | null
}

/**
 * 本地记账（IndexedDB chat-demo-sync / records 存储）。
 * digest 是「上次已知内容」的指纹：下一次同步用它判断这条记录本地有没有改过。
 */
export type RecordSnapshot = {
  /** kind: 与 id 拼成的主键 */
  key: string
  kind: SyncRecordKind
  id: string
  sessionId?: string
  updatedAt: number
  device: string
  deletedAt?: number
  digest: string
}

/** 记录主键 */
export const recordKey = (kind: SyncRecordKind, id: string): string => kind + ':' + id

/** 是否为墓碑 */
export const isTombstone = (record: { deletedAt?: number }): boolean => record.deletedAt != null

/** 递归按 key 排序后的 JSON：同一份内容在任何键序下都得到同一个字符串 */
const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key])
    }
    return sorted
  }
  return value
}

/** 规范化 JSON（值为 undefined 的字段会被丢掉，与从服务端读回来的形状一致） */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(sortValue(value)) ?? 'null'

/**
 * 内容指纹：两路 32 位散列（FNV-1a 与变体 djb2）拼成 64 位，再带上长度。
 * 不用 crypto.subtle：本 demo 支持以 file:// 打开，那里不是安全上下文。
 * 碰撞概率在本项目的量级下可以忽略，且碰撞只造成一次冗余推送，不会丢数据。
 */
export const digest = (value: unknown): string => {
  const text = canonicalJson(value)
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
    b = (b ^ (b >>> 13)) >>> 0
  }
  const hex = (value: number) => value.toString(16).padStart(8, '0')
  return hex(a) + hex(b) + ':' + text.length
}

/**
 * 会话记录的指纹只看这些字段。
 * 会话的 updatedAt 会随消息活动变化（发一条消息就变），若算进指纹，
 * 「A 端聊天 + B 端改标题」就会让 A 的会话记录盖掉 B 的标题，这里排掉它。
 */
export const sessionDigestSource = (data: SessionRecordData): unknown => ({
  id: data.id,
  title: data.title,
  createdAt: data.createdAt,
  rootMessageId: data.rootMessageId ?? null,
})

/**
 * 记录的指纹来源：会话按 sessionDigestSource，消息按完整内容；墓碑（data 为 null）统一为 null。
 * @param kind 记录种类
 * @param data 记录内容
 */
export const digestSource = (kind: SyncRecordKind, data: unknown): unknown =>
  data == null ? null : kind === 'session' ? sessionDigestSource(data as SessionRecordData) : data

/**
 * 记录版本比较：updatedAt 大者胜；相等时 device 字典序大者胜。
 * 后一条是刻意加的：纯毫秒 LWW 在撞车时两端会各留各的、永久分叉；
 * 加上这条确定性规则后，无论谁先同步都收敛到同一份。
 */
export const compareRecords = (
  a: { updatedAt: number; device: string },
  b: { updatedAt: number; device: string }
): number => {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? 1 : -1
  }
  if (a.device === b.device) {
    return 0
  }
  return a.device > b.device ? 1 : -1
}

/** data 是会话记录内容 */
export const isSessionRecordData = (value: unknown): value is SessionRecordData => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const data = value as Partial<SessionRecordData>
  return typeof data.id === 'string' && typeof data.title === 'string'
}

/** data 是消息记录内容：只做结构级校验，字段原样保留 */
export const isMessageRecordData = (value: unknown): value is Message => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const data = value as Partial<Message>
  return (
    typeof data.id === 'string' && (data.role === 'user' || data.role === 'assistant')
  )
}

/**
 * 校验从服务端读回的一条记录。
 * @param value 未知结构的对象
 * @returns 规范化后的记录；不合法返回 null（调用方跳过并在结果里计数）
 */
export const normalizeRecord = (value: unknown): SyncRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const source = value as Record<string, unknown>
  const { kind, id, sessionId, updatedAt, device, deletedAt, data } = source
  if (kind !== 'session' && kind !== 'message') {
    return null
  }
  if (typeof id !== 'string' || !id) {
    return null
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) {
    return null
  }
  if (typeof device !== 'string' || !device) {
    return null
  }
  const tombstone = deletedAt != null
  if (tombstone && (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt))) {
    return null
  }
  const record: SyncRecord = { kind, id, updatedAt, device, data: null }
  if (kind === 'message') {
    if (typeof sessionId !== 'string') {
      return null
    }
    record.sessionId = sessionId
  }
  if (tombstone) {
    record.deletedAt = deletedAt as number
    return record
  }
  if (kind === 'session' ? !isSessionRecordData(data) : !isMessageRecordData(data)) {
    return null
  }
  record.data = data as SessionRecordData | Message
  return record
}

