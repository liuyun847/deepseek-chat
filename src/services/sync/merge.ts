import type { Message, Session } from '../chat/types.js'
import {
  canonicalJson,
  compareRecords,
  digest,
  digestSource,
  recordKey,
  type RecordSnapshot,
  type SessionRecordData,
  type SyncRecord,
} from './protocol.js'

// ── 合并计划 ────────────────────────────────────────────────────────────────

export type MergePlan = {
  /** 本地更新或远端没有：要推给服务端 */
  push: SyncRecord[]
  /** 远端更新或本地没有：要写回本地 */
  pull: SyncRecord[]
  /** 两边版本相同（含都为墓碑） */
  even: number
}

/**
 * 逐 key 比较本地与远端记录，算出要推什么、要拉什么。
 * 规则与 merge.ts 的 compareRecords 一致，服务端用同一套（见 sync-server/server.mjs）。
 */
export const planMerge = (
  local: Map<string, SyncRecord>,
  remote: Map<string, SyncRecord>
): MergePlan => {
  const push: SyncRecord[] = []
  const pull: SyncRecord[] = []
  let even = 0
  for (const [key, record] of local) {
    const other = remote.get(key)
    if (!other) {
      push.push(record)
      continue
    }
    const order = compareRecords(record, other)
    if (order > 0) {
      push.push(record)
    } else if (order < 0) {
      pull.push(other)
    } else {
      even += 1
    }
  }
  for (const [key, record] of remote) {
    if (!local.has(key)) {
      pull.push(record)
    }
  }
  return { push, pull, even }
}

/**
 * 会话已删除时，其消息记录一律墓碑化。
 * 墓碑字段只由会话墓碑推导（不看消息自己的时间戳），因此各端算出完全相同的记录，
 * 不会出现「A 端墓碑、B 端活记录」互相推翻的来回同步。
 * 规则与服务端 collapseDeletedSessions 逐条对应。
 *
 * @param records 合并后的记录表，原地修改
 * @returns 被墓碑化的消息条数
 */
export const collapseDeletedSessions = (records: Map<string, SyncRecord>): number => {
  let collapsed = 0
  for (const session of records.values()) {
    if (session.kind !== 'session' || session.deletedAt == null) {
      continue
    }
    for (const record of records.values()) {
      if (record.kind !== 'message' || record.sessionId !== session.id) {
        continue
      }
      if (record.deletedAt != null) {
        continue
      }
      record.updatedAt = session.updatedAt
      record.device = session.device
      record.deletedAt = session.deletedAt
      record.data = null
      collapsed += 1
    }
  }
  return collapsed
}

// ── 本地记录构建 ────────────────────────────────────────────────────────────

export type BuildLocalInput = {
  sessions: Session[]
  /** 上次同步留下的记账 */
  snapshots: Map<string, RecordSnapshot>
  /** 本机设备 id */
  device: string
  /** 当前时间（注入便于确定性验证） */
  now: number
}

export type BuildLocalResult = {
  records: Map<string, SyncRecord>
  /** 本次同步后应写回的记账 */
  snapshots: Map<string, RecordSnapshot>
}

/**
 * 由「当前本地会话 + 上次记账」算出本地记录表。
 *
 * 记录的 updatedAt 来源：
 *  - 记账里没有这条 → 本地新增：会话用 session.updatedAt、消息用 message.createdAt。
 *    用内容自带的时间而不是「现在」，避免把远端更新的一版压掉。
 *  - 指纹相同 → 本地没动：沿用记账里的 updatedAt / device。
 *  - 指纹不同 → 本地改过：now（时钟倒退时取 max(now, 记账值 + 1)，保证单调）。
 *  - 记账是墓碑、当前又有内容 → 本地重建（例如导入 ZIP）：now。
 *  - 记账里有、当前没有 → 本地删除：墓碑，updatedAt = deletedAt = now。
 */
export const buildLocalRecords = ({
  sessions,
  snapshots,
  device,
  now,
}: BuildLocalInput): BuildLocalResult => {
  const records = new Map<string, SyncRecord>()
  const next = new Map<string, RecordSnapshot>()

  /** 算出这一版内容该用的时间戳与设备 id */
  const resolve = (
    snapshot: RecordSnapshot | undefined,
    fingerprint: string,
    born: number
  ): { updatedAt: number; device: string } => {
    if (!snapshot) {
      return { updatedAt: born, device }
    }
    if (snapshot.deletedAt == null && snapshot.digest === fingerprint) {
      return { updatedAt: snapshot.updatedAt, device: snapshot.device }
    }
    return { updatedAt: Math.max(now, snapshot.updatedAt + 1), device }
  }

  const commit = (record: SyncRecord, fingerprint: string) => {
    const key = recordKey(record.kind, record.id)
    records.set(key, record)
    const snapshot: RecordSnapshot = {
      key,
      kind: record.kind,
      id: record.id,
      updatedAt: record.updatedAt,
      device: record.device,
      digest: fingerprint,
    }
    if (record.sessionId !== undefined) {
      snapshot.sessionId = record.sessionId
    }
    if (record.deletedAt !== undefined) {
      snapshot.deletedAt = record.deletedAt
    }
    next.set(key, snapshot)
  }

  for (const session of sessions) {
    const data: SessionRecordData = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
    // undefined 表示「线性消息列表」，null 表示「空会话」，语义不同，不能合并成同一个值
    if (session.rootMessageId !== undefined) {
      data.rootMessageId = session.rootMessageId
    }
    
    const sessionDigest = digest(digestSource('session', data))
    const sessionStamp = resolve(
      snapshots.get(recordKey('session', session.id)),
      sessionDigest,
      session.updatedAt
    )
    commit(
      {
        kind: 'session',
        id: session.id,
        updatedAt: sessionStamp.updatedAt,
        device: sessionStamp.device,
        data,
      },
      sessionDigest
    )

    for (const message of session.messages) {
      const fingerprint = digest(digestSource('message', message))
      const stamp = resolve(
        snapshots.get(recordKey('message', message.id)),
        fingerprint,
        message.createdAt
      )
      commit(
        {
          kind: 'message',
          id: message.id,
          sessionId: session.id,
          updatedAt: stamp.updatedAt,
          device: stamp.device,
          data: message,
        },
        fingerprint
      )
    }
  }

  // 本地删掉的：记账里有、当前内容里没有 → 墓碑（否则另一端会把它当「新记录」拉回来）
  for (const [key, snapshot] of snapshots) {
    if (next.has(key)) {
      continue
    }
    if (snapshot.deletedAt != null) {
      next.set(key, snapshot)
      records.set(key, {
        kind: snapshot.kind,
        id: snapshot.id,
        ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
        updatedAt: snapshot.updatedAt,
        device: snapshot.device,
        deletedAt: snapshot.deletedAt,
        data: null,
      })
      continue
    }
    const stamp = Math.max(now, snapshot.updatedAt + 1)
    commit(
      {
        kind: snapshot.kind,
        id: snapshot.id,
        ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
        updatedAt: stamp,
        device,
        deletedAt: stamp,
        data: null,
      },
      digest(null)
    )
  }

  return { records, snapshots: next }
}

/**
 * 把合并后的记录表转成本地记账（整份写回 chat-demo-sync）。
 * 记账必须与记录表严格一致：少一条会让该记录下次被当成「本地新增」重复推送。
 */
export const recordsToSnapshots = (records: Iterable<SyncRecord>): RecordSnapshot[] => {
  const snapshots: RecordSnapshot[] = []
  for (const record of records) {
    const snapshot: RecordSnapshot = {
      key: recordKey(record.kind, record.id),
      kind: record.kind,
      id: record.id,
      updatedAt: record.updatedAt,
      device: record.device,
      digest: digest(digestSource(record.kind, record.data)),
    }
    if (record.sessionId !== undefined) {
      snapshot.sessionId = record.sessionId
    }
    if (record.deletedAt !== undefined) {
      snapshot.deletedAt = record.deletedAt
    }
    snapshots.push(snapshot)
  }
  return snapshots
}

// ── 落地 ────────────────────────────────────────────────────────────────────

export type ApplyResult = {
  /** 需要写回 IndexedDB 的会话（含新建与改动） */
  upserts: Session[]
  /** 需要从 IndexedDB 删除的会话 id */
  removed: string[]
}

/** 消息按创建顺序存放（与 store 的既有约定一致）；同一毫秒时用 id 保证确定性 */
const sortMessages = (messages: Message[]): Message[] =>
  [...messages].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * 防御性修复：悬空的 rootMessageId / parentId / selectedChildId 清成空值。
 * 正常同步流程不会触发，只在记录被外部删改（例如手工编辑数据文件）时兜底。
 */
const repairSession = (session: Session): Session => {
  const ids = new Set(session.messages.map((message) => message.id))
  let changed = false
  const messages = session.messages.map((message) => {
    const parentMissing = message.parentId != null && !ids.has(message.parentId)
    const childMissing = message.selectedChildId != null && !ids.has(message.selectedChildId)
    if (!parentMissing && !childMissing) {
      return message
    }
    changed = true
    return {
      ...message,
      ...(parentMissing ? { parentId: null } : {}),
      ...(childMissing ? { selectedChildId: undefined } : {}),
    }
  })
  let rootMessageId = session.rootMessageId
  if (rootMessageId !== undefined) {
    if (messages.length === 0) {
      if (rootMessageId !== null) {
        rootMessageId = null
        changed = true
      }
    } else if (rootMessageId === null || !ids.has(rootMessageId)) {
      rootMessageId = messages[0]?.id ?? null
      changed = true
    }
  }
  return changed ? { ...session, messages, rootMessageId } : session
}

/**
 * 把远端赢的记录写到本地会话上。
 * 会话记录只覆盖会话级字段（标题、创建时间、rootMessageId），消息一律由消息记录决定；
 * 先应用会话记录，再应用消息记录，这样子记录总能找到归属会话。
 *
 * @param sessions 当前本地全部会话
 * @param pulled 远端赢的记录
 * @returns 需要写回的会话与需要删除的会话 id
 */
export const applyPulledRecords = (sessions: Session[], pulled: SyncRecord[]): ApplyResult => {
  const byId = new Map<string, Session>()
  for (const session of sessions) {
    byId.set(session.id, { ...session, messages: [...session.messages] })
  }
  const touched = new Set<string>()
  const removed = new Set<string>()

  // 先处理会话记录：消息记录要按 sessionId 找到归属，删除也要先生效
  for (const record of pulled) {
    if (record.kind !== 'session') {
      continue
    }
    if (record.deletedAt != null) {
      if (byId.delete(record.id)) {
        removed.add(record.id)
      }
      touched.delete(record.id)
      continue
    }
    const data = record.data as SessionRecordData
    const existing = byId.get(record.id)
    if (!existing) {
      byId.set(record.id, {
        id: data.id,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messages: [],
        ...(data.rootMessageId === undefined ? {} : { rootMessageId: data.rootMessageId }),
      })
      touched.add(record.id)
      continue
    }
    // 会话的 updatedAt 只往前走：本地消息活动比远端记录新时不能倒退回旧时间
    const updatedAt = Math.max(existing.updatedAt, data.updatedAt)
    const next: Session = {
      ...existing,
      title: data.title,
      createdAt: data.createdAt,
      updatedAt,
    }
    if (data.rootMessageId === undefined) {
      delete next.rootMessageId
    } else {
      next.rootMessageId = data.rootMessageId
    }
    if (canonicalJson(next) !== canonicalJson(existing)) {
      byId.set(record.id, next)
      touched.add(record.id)
    }
  }

  // 再处理消息记录：会话已被上面删掉的一律丢弃（会话删除优先于其消息的独立变更）
  for (const record of pulled) {
    if (record.kind !== 'message') {
      continue
    }
    const sessionId = record.sessionId
    const session = sessionId === undefined ? undefined : byId.get(sessionId)
    if (!session) {
      continue
    }
    const index = session.messages.findIndex((message) => message.id === record.id)
    if (record.deletedAt != null) {
      if (index >= 0) {
        session.messages.splice(index, 1)
        touched.add(session.id)
      }
      continue
    }
    const message = record.data as Message
    if (index >= 0) {
      if (canonicalJson(session.messages[index]) === canonicalJson(message)) {
        continue
      }
      session.messages.splice(index, 1, message)
    } else {
      session.messages.push(message)
    }
    touched.add(session.id)
  }

  const upserts: Session[] = []
  for (const id of touched) {
    const session = byId.get(id)
    if (!session) {
      continue
    }
    const sorted = { ...session, messages: sortMessages(session.messages) }
    // 空消息的会话照样保留（新建的空会话），只是没有分支信息
    upserts.push(repairSession(sorted))
  }
  return { upserts, removed: [...removed] }
}

