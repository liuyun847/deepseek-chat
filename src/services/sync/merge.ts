import type { Message, Session } from '../chat/types.js'
import {
  canonicalJson,
  compareRecords,
  digest,
  digestSource,
  PROMPT_SELECTION_RECORD_ID,
  recordKey,
  SETTINGS_RECORD_ID,
  type PromptEntry,
  type PromptRecordData,
  type PromptSelectionData,
  type PromptSelectionEntry,
  type RecordSnapshot,
  type SessionRecordData,
  type SyncedSettings,
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
  /**
   * 要同步的设置整份（已剔除 apiKey / syncDeviceId / LAN 键）。
   * 省略或 null 表示本端这次不产出设置记录（例如存储读不出来），此时已有记录原样保留，
   * 不会被当成「本地删除了设置」而墓碑化。
   */
  settings?: SyncedSettings | null
  /** 设置的最后修改时间（毫秒），见 settings.ts 的 loadSettingsUpdatedAt */
  settingsUpdatedAt?: number
  /** 本地提示词库（活项，带各自的最后修改时间） */
  prompts?: PromptEntry[]
  /** 提示词的墓碑表：id → 删除时刻 */
  promptTombstones?: Record<string, number>
  /** 当前选中的提示词（含最后修改时间）；省略表示本次不参与同步 */
  promptSelection?: PromptSelectionEntry | null
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
 *
 * 设置 / 提示词 / 选中项的 updatedAt 另有来源（各自的「本地最后修改时间」，见下面
 * resolveOwned），因为它们不是「由内容自带的时间推导」，而是用户每次操作时刷新出来的。
 */
export const buildLocalRecords = ({
  sessions,
  snapshots,
  device,
  now,
  settings = null,
  settingsUpdatedAt = 0,
  prompts = [],
  promptTombstones = {},
  promptSelection = null,
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

  // ── 设置 / 提示词 / 选中项 ──────────────────────────────────────────────
  // 这三类记录自带「本地最后修改时间」（settings.ts / prompts.ts 在用户操作时刷新），
  // 所以内容变了就用它当 updatedAt，而不是用「现在」——两端比的是「谁最后改的」，
  // 而不是「谁最后同步的」；内容没变则沿用记账里的版本，同步本身不会产生「更新」。
  const resolveOwned = (
    snapshot: RecordSnapshot | undefined,
    fingerprint: string,
    own: number
  ): { updatedAt: number; device: string } => {
    if (!snapshot) {
      return { updatedAt: Math.max(own, 0), device }
    }
    if (snapshot.deletedAt == null && snapshot.digest === fingerprint) {
      return { updatedAt: snapshot.updatedAt, device: snapshot.device }
    }
    return { updatedAt: Math.max(own, snapshot.updatedAt + 1), device }
  }

  // 设置：整份一条，id 固定，冲突由整份的 LWW 决定（最新的整份覆盖旧的整份）
  if (settings) {
    const fingerprint = digest(digestSource('settings', settings))
    const stamp = resolveOwned(
      snapshots.get(recordKey('settings', SETTINGS_RECORD_ID)),
      fingerprint,
      settingsUpdatedAt
    )
    commit(
      {
        kind: 'settings',
        id: SETTINGS_RECORD_ID,
        updatedAt: stamp.updatedAt,
        device: stamp.device,
        data: settings,
      },
      fingerprint
    )
  }

  // 提示词：逐条一条记录，删除靠墓碑（见下面的 promptTombstones 循环）
  const livePrompts = new Set<string>()
  for (const prompt of prompts) {
    livePrompts.add(prompt.id)
    const data: PromptRecordData = {
      id: prompt.id,
      name: prompt.name,
      content: prompt.content,
      createdAt: prompt.createdAt,
    }
    const fingerprint = digest(digestSource('prompt', data))
    const stamp = resolveOwned(
      snapshots.get(recordKey('prompt', prompt.id)),
      fingerprint,
      prompt.updatedAt
    )
    commit(
      { kind: 'prompt', id: prompt.id, updatedAt: stamp.updatedAt, device: stamp.device, data },
      fingerprint
    )
  }

  // 提示词墓碑：删除是显式记下来的，删除时刻就是墓碑时间；已经记过的墓碑沿用记账里的版本
  for (const [id, deletedAt] of Object.entries(promptTombstones)) {
    if (livePrompts.has(id)) {
      continue
    }
    const snapshot = snapshots.get(recordKey('prompt', id))
    const stamp =
      snapshot?.deletedAt != null
        ? { updatedAt: snapshot.updatedAt, device: snapshot.device }
        : { updatedAt: Math.max(deletedAt, (snapshot?.updatedAt ?? 0) + 1), device }
    commit(
      {
        kind: 'prompt',
        id,
        updatedAt: stamp.updatedAt,
        device: stamp.device,
        deletedAt: stamp.updatedAt,
        data: null,
      },
      digest(null)
    )
  }

  // 选中项：整条 LWW（null 就是「用内置默认项」这一确定状态，不需要墓碑）
  if (promptSelection) {
    const data: PromptSelectionData = { selectedId: promptSelection.selectedId }
    const fingerprint = digest(digestSource('prompt-selection', data))
    const stamp = resolveOwned(
      snapshots.get(recordKey('prompt-selection', PROMPT_SELECTION_RECORD_ID)),
      fingerprint,
      promptSelection.updatedAt
    )
    commit(
      {
        kind: 'prompt-selection',
        id: PROMPT_SELECTION_RECORD_ID,
        updatedAt: stamp.updatedAt,
        device: stamp.device,
        data,
      },
      fingerprint
    )
  }

  // 本地删掉的：记账里有、当前内容里没有 → 墓碑（否则另一端会把它当「新记录」拉回来）
  for (const [key, snapshot] of snapshots) {
    if (next.has(key)) {
      continue
    }
    // 设置与选中项是「永远存在」的整份记录，没有删除语义：读不出来就跳过，
    // 否则一次读取失败就能把对端那份设置墓碑掉，之后再也没法拉回来
    if (snapshot.kind === 'settings' || snapshot.kind === 'prompt-selection') {
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
 * 只处理 session / message 两类记录：设置、提示词、选中项存在 localStorage，落地在
 * 同步层的 local.ts（buildLocalRecords 的逆操作），这里一律跳过。
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

// ── 非会话记录的落地（设置 / 提示词 / 选中项） ───────────────────────────────

/** 拉回来的非会话记录里，要落到本机 localStorage 的部分 */
export type LocalExtras = {
  /** 远端赢的设置整份；null 表示本次没有设置记录要落地 */
  settings: { data: SyncedSettings; updatedAt: number } | null
  /** 远端赢的提示词；data 为 null 表示墓碑（本地要删掉并记墓碑） */
  prompts: { id: string; data: PromptRecordData | null; updatedAt: number; deletedAt?: number }[]
  /** 远端赢的选中项 */
  selection: { selectedId: string | null; updatedAt: number } | null
}

/**
 * 从「远端赢的记录」里挑出要落到 localStorage 的部分。
 *
 * 纯函数：只分类，不碰存储（落地见 local.ts），方便脱离浏览器验证。
 *
 * @param pulled 远端赢的记录（merge 计划里的 pull / apply）
 * @returns 设置、提示词、选中项三路要落地的内容
 */
export const extractLocalExtras = (pulled: SyncRecord[]): LocalExtras => {
  const extras: LocalExtras = { settings: null, prompts: [], selection: null }
  for (const record of pulled) {
    if (record.kind === 'settings') {
      const data = record.data as SyncedSettings | null
      if (data) {
        extras.settings = { data, updatedAt: record.updatedAt }
      }
      continue
    }
    if (record.kind === 'prompt-selection') {
      const data = record.data as PromptSelectionData | null
      if (data) {
        extras.selection = { selectedId: data.selectedId, updatedAt: record.updatedAt }
      }
      continue
    }
    if (record.kind !== 'prompt') {
      continue
    }
    const item: LocalExtras['prompts'][number] = {
      id: record.id,
      data: record.data as PromptRecordData | null,
      updatedAt: record.updatedAt,
    }
    if (record.deletedAt !== undefined) {
      item.deletedAt = record.deletedAt
    }
    extras.prompts.push(item)
  }
  return extras
}

/**
 * 把远端赢的提示词合进本地库（纯函数）。
 *
 * 规则：
 *  - 本地有这一条 → 就地替换（保留原有顺序，界面上的位置不跳）
 *  - 本地没有 → 追加在已有项之后，并按 (createdAt, id) 排序，两端插入顺序因此收敛
 *  - 墓碑 → 从列表移除，并记进墓碑表（下次同步继续把删除传下去）
 *  - 活记录赢过本地墓碑 → 复活（删掉墓碑项），否则删除会永远压住后来的编辑
 *
 * @param local 本地提示词库（带时间戳）
 * @param tombstones 本地墓碑表 id → 删除时刻
 * @param extras 远端赢的提示词记录
 * @returns 新的列表与墓碑表；都不改入参
 */
export const mergePromptLibrary = (
  local: PromptEntry[],
  tombstones: Record<string, number>,
  extras: LocalExtras['prompts']
): { prompts: PromptEntry[]; tombstones: Record<string, number> } => {
  const list = local.map((prompt) => ({ ...prompt }))
  const appended: PromptEntry[] = []
  const deleted = { ...tombstones }
  for (const item of extras) {
    const index = list.findIndex((prompt) => prompt.id === item.id)
    if (item.data === null) {
      const at = item.deletedAt ?? item.updatedAt
      if (index >= 0) {
        list.splice(index, 1)
      }
      deleted[item.id] = Math.max(at, deleted[item.id] ?? 0)
      continue
    }
    const entry: PromptEntry = { ...item.data, updatedAt: item.updatedAt }
    if (index >= 0) {
      list.splice(index, 1, entry)
    } else {
      appended.push(entry)
    }
  }
  appended.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const merged = [...list, ...appended]
  // 同一个 id 不能同时是活项和墓碑：活项赢就清掉墓碑
  const live = new Set(merged.map((prompt) => prompt.id))
  const keptTombstones: Record<string, number> = {}
  for (const [id, at] of Object.entries(deleted)) {
    if (!live.has(id)) {
      keptTombstones[id] = at
    }
  }
  return { prompts: merged, tombstones: keptTombstones }
}
