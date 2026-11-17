import type { Message } from '../chat/types.js'

/** 协议标识：客户端与服务端必须一致，否则拒绝（避免两套语义互相污染） */
export const SYNC_FORMAT = 'chat-demo-sync'
/**
 * 协议版本；记录结构或合并规则改了就要 +1。
 *
 * v1 → v2：新增三种记录 —— settings（整份设置，固定 id）、prompt（提示词，逐条）、
 * prompt-selection（当前选中的提示词，整条）。
 *
 * 只升级一侧时的表现（属于预期，之后按提示升级另一侧即可，数据不会被写坏）：
 *  - 旧客户端（v1）× 新服务端（v2）：客户端 checkFormat 看到服务端 version 比自己的大，
 *    直接报「同步服务的协议版本比本页更新」并拒绝同步，什么都不写。
 *  - 新客户端（v2）× 旧服务端（v1）：服务端的 normalizeRecord 不认新 kind，整批推送被判非法
 *    并回 400（客户端显示「服务端返回的数据无法识别」）。
 */
export const SYNC_VERSION = 2
/** 单次推送的体积上限（32 MB），与服务端 MAX_BODY 一致 */
export const MAX_SYNC_BYTES = 32 * 1024 * 1024

/**
 * 记录种类：
 *  - session / message：会话（不含消息）与消息，逐条同步
 *  - settings：整份可同步设置，固定一条
 *  - prompt：提示词库的每一条，逐条同步（删除用墓碑）
 *  - prompt-selection：当前选中的提示词，整条 LWW
 */
export type SyncRecordKind = 'session' | 'message' | 'settings' | 'prompt' | 'prompt-selection'

/**
 * 设置记录的固定 id（recordKey 拼出来是 `settings:device-agnostic`）。
 * 设置是「一整份、与设备无关」的东西，没有逐条粒度，因此 id 固定。
 */
export const SETTINGS_RECORD_ID = 'device-agnostic'

/**
 * 选中项记录的固定 id（recordKey 拼出来是 `prompt-selection:selected`）。
 * 选中项单独成一种记录而不是塞进设置那一份：它变化频率与语义都和设置键不同
 * （改选中项不该让整份设置的时间戳跳一下，反之亦然），分开后两者互不覆盖。
 */
export const PROMPT_SELECTION_RECORD_ID = 'selected'

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

/** 位置设置的可同步形状（与 settings.ts 的 UserLocation 同构，同步层不反向依赖业务模块） */
export type SyncedLocation = { region: string; province?: string; city?: string }

/**
 * 可同步的设置整份（一条记录装全部可同步项）。
 *
 * 以下键刻意不在这里，构造记录时不放、落地时也不会写回本机：
 *  - apiKey：密钥只留在本机。同步出去的记录会原样存进服务端的数据文件，
 *    等于把 key 复制一份到别人的磁盘上，因此逐字不进记录。
 *  - syncDeviceId：设备身份是冲突判定（tie-break）的基准，各端必须各存各的，否则两端会互认成同一台。
 *  - syncDeviceName：设备名是本机身份（界面上用来区分「这是哪台设备」），
 *    不应被跨端覆盖 —— 否则一次同步就会把本机名字改成对端的名字，之后再也看不出是哪台。
 *    它只由本机的 setSyncDeviceName 修改。
 *  - LAN 相关键（chat-demo:lan-enabled / lan-key / lan-pair-tag / lan-peers）：
 *    手机直连的口令链路与多端同步是两条独立通道，密钥跟着设备走，混进整份设置会让
 *    一台设备的口令覆盖另一台。
 *
 * syncServerUrl 留在同步范围内：它同样偏本机（各端可能连不同的服务），
 * 但它是用户明确要求跟随同步的设置项，因此整份 LWW 之后两端会被较新的一侧统一，属于预期。
 */
export type SyncedSettings = {
  locale: string
  themePreference: string
  /**
   * 字号档位（small / normal / large）。
   * 后加的键：比它老的客户端与服务端都不会写这个字段，因此校验时允许缺省，
   * 缺省按 normal 处理（见 sanitizeSyncedSettings）。
   */
  fontScale: string
  location: SyncedLocation | null
  model: string
  reasoningEffort: string
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  syncServerUrl: string
}

/**
 * 提示词记录的 data。id 与记录的 id 相同。
 * createdAt 只用于本地展示顺序，不参与指纹（见 promptDigestSource）。
 */
export type PromptRecordData = {
  id: string
  name: string
  content: string
  createdAt: number
}

/** 本机提示词的完整形状：记录 data + 本地最后修改时间（prompts.ts 与 merge.ts 共用） */
export type PromptEntry = PromptRecordData & { updatedAt: number }

/** 当前选中的提示词：null 表示用内置默认项。整条 LWW，不做逐字段合并 */
export type PromptSelectionData = { selectedId: string | null }

/** 本机选中的提示词 + 本地最后修改时间 */
export type PromptSelectionEntry = { selectedId: string | null; updatedAt: number }

/** 记录内容的联合类型 */
export type RecordData =
  | SessionRecordData
  | Message
  | SyncedSettings
  | PromptRecordData
  | PromptSelectionData

/** 一条同步记录（线上格式） */
export type SyncRecord = {
  kind: SyncRecordKind
  id: string
  /** 消息记录所属会话；其它种类没有这个字段 */
  sessionId?: string
  /** 该记录内容最后一次变化的墙钟毫秒 */
  updatedAt: number
  /** 产生这一版内容的设备 id，仅用于 updatedAt 撞车时的 tie-break */
  device: string
  /** 非空即墓碑：内容已删除，data 置为 null（只有 session / message / prompt 会墓碑化） */
  deletedAt?: number
  /** 墓碑为 null */
  data: RecordData | null
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

/** 提示词指纹只看内容；createdAt 不变也不该影响冲突判定 */
export const promptDigestSource = (data: PromptRecordData): unknown => ({
  id: data.id,
  name: data.name,
  content: data.content,
})

/**
 * 记录的指纹来源：会话按 sessionDigestSource、提示词按 promptDigestSource，
 * 消息 / 设置 / 选中项按完整内容；墓碑（data 为 null）统一为 null。
 * @param kind 记录种类
 * @param data 记录内容
 */
export const digestSource = (kind: SyncRecordKind, data: unknown): unknown => {
  if (data == null) {
    return null
  }
  if (kind === 'session') {
    return sessionDigestSource(data as SessionRecordData)
  }
  if (kind === 'prompt') {
    return promptDigestSource(data as PromptRecordData)
  }
  return data
}

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

/** 提示词名 / 内容长度上限：与 prompts.ts 的 PROMPT_NAME_MAX / PROMPT_CONTENT_MAX 一致 */
export const PROMPT_NAME_MAX = 60
export const PROMPT_CONTENT_MAX = 4000

const LOCALES = ['zh-CN', 'en-US']
const THEME_PREFERENCES = ['light', 'dark', 'system']
const REASONING_EFFORTS = ['low', 'high', 'max']
const FONT_SCALES = ['small', 'normal', 'large']

const isOneOf = (value: unknown, allowed: string[]): value is string =>
  typeof value === 'string' && allowed.includes(value)

/** 非负整数时间戳；非法一律 0（旧数据里没有时间戳的项按 0 处理，LWW 依然确定） */
const stampOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * 校验并「白名单化」一份可同步设置。
 *
 * 逐字段重建而不是删键：只剩下面这十个字段，任何多余键（apiKey、syncDeviceId、
 * syncDeviceName、lan-* 等）都在这里消失，服务端落盘的记录因此不可能带上它们。
 *
 * @param value 未知结构
 * @returns 规范化后的设置；字段缺失或类型不对返回 null（调用方按非法记录处理）
 */
export const sanitizeSyncedSettings = (value: unknown): SyncedSettings | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const data = value as Record<string, unknown>
  const { locale, themePreference, model, reasoningEffort, syncServerUrl } = data
  const { thinking, search, siderCollapsed, fontScale } = data
  if (!isOneOf(locale, LOCALES) || !isOneOf(themePreference, THEME_PREFERENCES)) {
    return null
  }
  if (!isOneOf(reasoningEffort, REASONING_EFFORTS)) {
    return null
  }
  if (typeof model !== 'string' || !model) {
    return null
  }
  if (
    typeof thinking !== 'boolean' ||
    typeof search !== 'boolean' ||
    typeof siderCollapsed !== 'boolean'
  ) {
    return null
  }
  if (typeof syncServerUrl !== 'string') {
    return null
  }
  // fontScale 是后加的键：旧客户端写的记录、以及白名单还没跟上它的服务端落盘的记录里
  // 都没有这个字段，缺省按 normal 补齐。若在这里要求必填，一份老记录会整条判非法，
  // 那台设备就再也拉不回设置（拉取时每次都被当成坏记录跳过）。
  const scale = fontScale === undefined || fontScale === null ? 'normal' : fontScale
  if (!isOneOf(scale, FONT_SCALES)) {
    return null
  }
  const raw = data.location
  let location: SyncedLocation | null = null
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return null
    }
    const { region, province, city } = raw as Record<string, unknown>
    if (typeof region !== 'string' || !region) {
      return null
    }
    if (province !== undefined && typeof province !== 'string') {
      return null
    }
    if (city !== undefined && typeof city !== 'string') {
      return null
    }
    location = typeof province === 'string' ? { region, province } : { region }
    if (typeof city === 'string') {
      location.city = city
    }
  }
  return {
    locale,
    themePreference,
    fontScale: scale,
    location,
    model,
    reasoningEffort,
    thinking,
    search,
    siderCollapsed,
    syncServerUrl,
  }
}

/**
 * 校验一份提示词记录内容。
 * @param value 未知结构
 * @returns 规范化后的 data；字段缺失、超长或 id 不合法返回 null
 */
export const sanitizePromptRecordData = (value: unknown, id: string): PromptRecordData | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const data = value as Record<string, unknown>
  const { name, content } = data
  if (typeof data.id !== 'string' || data.id !== id) {
    return null
  }
  if (typeof name !== 'string' || !name || name.length > PROMPT_NAME_MAX) {
    return null
  }
  if (typeof content !== 'string' || !content || content.length > PROMPT_CONTENT_MAX) {
    return null
  }
  return { id, name, content, createdAt: stampOf(data.createdAt) }
}

/**
 * 校验一份「当前选中项」记录内容。
 * @param value 未知结构
 * @returns 规范化后的 data；selectedId 既不是字符串也不是 null 时返回 null
 */
export const sanitizePromptSelection = (value: unknown): PromptSelectionData | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const selectedId = (value as Record<string, unknown>).selectedId
  if (selectedId !== null && typeof selectedId !== 'string') {
    return null
  }
  return { selectedId }
}

/**
 * 校验从服务端（或对端）读回的一条记录。
 *
 * 与服务端 sync-server/server.mjs 的 normalizeRecord 必须逐条对应：两边对「合法」的判断
 * 不一致，会出现「一端认为要推、另一端整批 400」的僵局。
 *
 * @param value 未知结构的对象
 * @returns 规范化后的记录；不合法返回 null（调用方跳过并在结果里计数）
 */
export const normalizeRecord = (value: unknown): SyncRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const source = value as Record<string, unknown>
  const { kind, id, sessionId, updatedAt, device, deletedAt, data } = source
  if (
    kind !== 'session' &&
    kind !== 'message' &&
    kind !== 'settings' &&
    kind !== 'prompt' &&
    kind !== 'prompt-selection'
  ) {
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
  // 设置与选中项是「永远存在」的整份记录，没有删除语义：墓碑一律视为非法，
  // 否则一次读取失败就能把对端那份设置墓碑掉，之后再也拉不回来。
  if (tombstone && (kind === 'settings' || kind === 'prompt-selection')) {
    return null
  }
  // 固定 id 的种类必须用约定的 id，避免同一份设置被拆成多条记录互相打
  if (kind === 'settings' && id !== SETTINGS_RECORD_ID) {
    return null
  }
  if (kind === 'prompt-selection' && id !== PROMPT_SELECTION_RECORD_ID) {
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
  if (kind === 'session') {
    if (!isSessionRecordData(data)) {
      return null
    }
    record.data = data
    return record
  }
  if (kind === 'message') {
    if (!isMessageRecordData(data)) {
      return null
    }
    record.data = data
    return record
  }
  if (kind === 'settings') {
    const settings = sanitizeSyncedSettings(data)
    if (!settings) {
      return null
    }
    record.data = settings
    return record
  }
  if (kind === 'prompt') {
    const prompt = sanitizePromptRecordData(data, id)
    if (!prompt) {
      return null
    }
    record.data = prompt
    return record
  }
  const selection = sanitizePromptSelection(data)
  if (!selection) {
    return null
  }
  record.data = selection
  return record
}
