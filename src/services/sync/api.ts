import type { TranslationKey } from '../../i18n/index.js'
import { isLoopbackHostname } from '../localService.js'
import {
  normalizeRecord,
  SYNC_FORMAT,
  SYNC_VERSION,
  type SyncRecord,
} from './protocol.js'

/** 单次请求的超时（毫秒）；拉全量可能略慢，推送与探测给同样的时间 */
const REQUEST_TIMEOUT = 15_000

/**
 * 同步相关的可预期错误：带文案 key，界面按当前语言翻译，不用拼字符串。
 */
export class SyncError extends Error {
  readonly key: TranslationKey
  readonly detail?: string
  status?: number

  constructor(key: TranslationKey, detail?: string, status?: number) {
    super(detail ?? key)
    this.name = 'SyncError'
    this.key = key
    this.detail = detail
    this.status = status
  }
}

/** 服务地址：允许省略协议（补 https://），去掉结尾斜杠 */
export const normalizeServerUrl = (input: string): string | null => {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    // 明文只允许回环（本机调试）；局域网/公网地址一律要求 HTTPS
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
      return null
    }
    return (url.origin + url.pathname).replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * 同源同步的「服务地址」在本页同源下的前缀。
 *
 * 服务地址的语义是「端点 /api/* 之前的基址」：手填 http://127.0.0.1:7788 时，
 * 请求落到 http://127.0.0.1:7788/api/health。同源场景同理 —— 基址取 /sync，
 * 端点就是 /sync/api/health，local-server 再把 /sync/api/* 转到 127.0.0.1:7788/api/*。
 * 因此这里是 /sync 而不是 /sync/api（后者会让端点变成 /sync/api/api/health）。
 */
export const SAME_ORIGIN_SYNC_BASE = '/sync'

/**
 * 本页同源的反代地址；不在回环 http(s) 页面上时返回 null。
 *
 * APK（https://dsapp.local）与 file:// 都拿不到回环 host，因此这里恒为 null ——
 * 这也是「APK 不会误用同源」的第一道保险（第二道在 resolveServerUrl 的 localService 参数）。
 *
 * @returns 形如 http://127.0.0.1:7789/sync（端点即 /sync/api/*）
 */
export const sameOriginServer = (): string | null => {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) {
    return null
  }
  if (!isLoopbackHostname(location.hostname)) {
    return null
  }
  return location.origin + SAME_ORIGIN_SYNC_BASE
}

/**
 * 这次同步实际连哪个服务地址。
 *
 * 优先级：设置里手填的地址 > 同源反代（仅当本页确实由本机服务托管）> null（没得连）。
 * 手填优先是刻意的：填了就说明用户明确要连那台机器（比如局域网里跑 sync-server 的电脑），
 * 此时不能因为「本页恰好也被 7789 托管」就偷偷改道。
 *
 * @param typed 设置里的 syncServerUrl 原始值
 * @param localService 本页是否由本机服务托管（即 localServiceReady 的结果）
 * @returns 规范化后的地址；两者都不成立时 null
 */
export const resolveServerUrl = (typed: string, localService: boolean): string | null => {
  const configured = normalizeServerUrl(typed)
  if (configured) {
    return configured
  }
  return localService ? sameOriginServer() : null
}

type RequestOptions = { body?: unknown; timeout?: number; token?: string }

/** 本机服务（local-server）在同步服务连不上时回的 error.type */
const SYNC_UPSTREAM_DOWN = 'sync_upstream_down'
/** 同上：同步服务 10 秒没响应 */
const SYNC_UPSTREAM_TIMEOUT = 'sync_upstream_timeout'

/**
 * 读错误响应体，尽量给出一句人能看懂的原因。
 *
 * 两种上游的错体形状不同：sync-server 是 { ok:false, error:'中文原因' }，
 * 本机服务是 { error: { type, message } }。type 决定走哪条固定文案，
 * message 填进 {message} 占位符；解析不出来就退回截断的原文。
 *
 * @param response 失败的响应
 * @returns 结构化的 type 与 message
 */
const readErrorBody = async (response: Response): Promise<{ type: string; message: string }> => {
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  if (!text) {
    return { type: '', message: String(response.status) }
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null
    const error = parsed?.error
    if (typeof error === 'string') {
      return { type: '', message: error.slice(0, 200) }
    }
    if (error && typeof error === 'object') {
      const typed = error as { type?: unknown; message?: unknown }
      return {
        type: typeof typed.type === 'string' ? typed.type : '',
        message: typeof typed.message === 'string' ? typed.message.slice(0, 200) : text.slice(0, 200),
      }
    }
  } catch {
    // 不是 JSON：按原文
  }
  return { type: '', message: text.slice(0, 200) }
}

/**
 * 发一次 JSON 请求并把错误映射成 SyncError。
 * @param url 完整地址
 * @param options 请求体与超时
 * @returns 解析后的 JSON
 */
const request = async (url: string, options: RequestOptions = {}): Promise<unknown> => {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeout ?? REQUEST_TIMEOUT
  )
  let response: Response
  try {
    const headers: Record<string, string> = {}
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`
    }
    response = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch {
    throw new SyncError('syncErrorNetwork')
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const { type, message } = await readErrorBody(response)
    // 同步服务没起来（本机服务回的 502）：换成一句能照着做的固定文案，别把 JSON 拼进提示
    if (type === SYNC_UPSTREAM_DOWN) {
      throw new SyncError('syncErrorNotRunning', message, response.status)
    }
    // 卡住不回话（本机服务的 10 秒超时）：按「连不上」处理，同样给固定文案
    if (type === SYNC_UPSTREAM_TIMEOUT) {
      throw new SyncError('syncErrorNetwork', undefined, response.status)
    }
    if (response.status === 404) {
      throw new SyncError('syncErrorNotFound', message, response.status)
    }
    if (response.status === 401) {
      throw new SyncError('syncErrorUnauthorized', message, response.status)
    }
    if (response.status === 409) {
      throw new SyncError('syncErrorEpoch', message, response.status)
    }
    throw new SyncError(
      response.status >= 500 ? 'syncErrorServer' : 'syncErrorResponse',
      message || String(response.status),
      response.status
    )
  }
  try {
    return await response.json()
  } catch {
    throw new SyncError('syncErrorResponse')
  }
}

/** 服务自报的身份与统计（「测试连接」用） */
export type HealthInfo = {
  name: string
  time: number
  /** 服务端记录总数（含墓碑与设置/提示词） */
  records: number
  sessions: number
  messages: number
  /** 服务端有没有同步过设置那一份（0 或 1） */
  settings: number
  /** 服务端提示词条数（活记录，不含墓碑） */
  prompts: number
  dataFile: string
  /** 服务端是否启用了 HTTPS */
  tls: boolean
  /** 自签证书的 SHA-256 指纹；未启用 TLS 时 null */
  tlsFingerprint: string | null
  /** 组信息；未建组时为 null / 0 */
  groupId: string | null
  groupName: string | null
  hostDeviceId: string | null
  groupEpoch: number | null
  groupDevices: number
}

/** 把 JSON 里的 records 数组校验成记录列表；不合法条目直接丢掉并在 reason 里体现 */
const parseRecords = (value: unknown): SyncRecord[] => {
  if (!Array.isArray(value)) {
    throw new SyncError('syncErrorResponse')
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

/** 校验响应头里自报的协议，避免把别的 HTTP 服务当成同步服务 */
const checkFormat = (body: Record<string, unknown>) => {
  if (body.format !== SYNC_FORMAT) {
    throw new SyncError('syncErrorNotFound')
  }
  if (typeof body.version === 'number' && body.version > SYNC_VERSION) {
    throw new SyncError('syncErrorVersion')
  }
}

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncError('syncErrorResponse')
  }
  return value as Record<string, unknown>
}

/** 探活 + 统计 */
export const fetchHealth = async (serverUrl: string, token?: string): Promise<HealthInfo> => {
  const body = asObject(await request(serverUrl + '/api/health', { timeout: 8000, token }))
  checkFormat(body)
  return {
    name: typeof body.name === 'string' ? body.name : serverUrl,
    time: typeof body.time === 'number' ? body.time : Date.now(),
    records: typeof body.records === 'number' ? body.records : 0,
    sessions: typeof body.sessions === 'number' ? body.sessions : 0,
    messages: typeof body.messages === 'number' ? body.messages : 0,
    settings: typeof body.settings === 'number' ? body.settings : 0,
    prompts: typeof body.prompts === 'number' ? body.prompts : 0,
    dataFile: typeof body.dataFile === 'string' ? body.dataFile : '',
    tls: body.tls === true,
    tlsFingerprint: typeof body.tlsFingerprint === 'string' ? body.tlsFingerprint : null,
    groupId: typeof body.groupId === 'string' ? body.groupId : null,
    groupName: typeof body.groupName === 'string' ? body.groupName : null,
    hostDeviceId: typeof body.hostDeviceId === 'string' ? body.hostDeviceId : null,
    groupEpoch: typeof body.groupEpoch === 'number' ? body.groupEpoch : null,
    groupDevices: typeof body.groupDevices === 'number' ? body.groupDevices : 0,
  }
}

/** 拉全量记录（含墓碑）；加入组后必须带设备令牌 */
export const fetchState = async (serverUrl: string, token?: string): Promise<SyncRecord[]> => {
  const body = asObject(await request(serverUrl + '/api/state', { token }))
  checkFormat(body)
  return parseRecords(body.records)
}

export type PushResult = {
  records: SyncRecord[]
  accepted: number
  rejected: number
}

/** 推送变更，返回服务端合并后的全量 */
export const pushRecords = async (
  serverUrl: string,
  device: string,
  records: SyncRecord[],
  token?: string,
  epoch?: number
): Promise<PushResult> => {
  const body = asObject(
    await request(serverUrl + '/api/sync', {
      token,
      body: {
        format: SYNC_FORMAT,
        version: SYNC_VERSION,
        device,
        records,
        ...(typeof epoch === 'number' ? { epoch } : {}),
      },
    })
  )
  checkFormat(body)
  const applied = body.applied && typeof body.applied === 'object' ? body.applied : {}
  return {
    records: parseRecords(body.records),
    accepted: typeof (applied as Record<string, unknown>).accepted === 'number'
      ? ((applied as Record<string, unknown>).accepted as number)
      : 0,
    rejected: typeof (applied as Record<string, unknown>).rejected === 'number'
      ? ((applied as Record<string, unknown>).rejected as number)
      : 0,
  }
}

// ── 组与配对 ────────────────────────────────────────────────────────────────

export type GroupDevice = {
  id: string
  name: string
  canHost: boolean
  joinedAt: number
  lastSeenAt: number | null
}

export type GroupInfo = {
  groupId: string
  groupName: string
  hostDeviceId: string
  epoch: number
  createdAt: number
  devices: GroupDevice[]
}

export type InviteInfo = { code: string; expiresAt: number }
export type CreateGroupResult = { group: GroupInfo; deviceToken: string; invite: InviteInfo }
export type JoinGroupResult = { group: GroupInfo; deviceToken: string }

/** 校验服务端返回的组结构；字段缺失按协议错误处理 */
const parseGroup = (value: unknown): GroupInfo => {
  const group = asObject(value)
  if (
    typeof group.groupId !== 'string' ||
    typeof group.groupName !== 'string' ||
    typeof group.hostDeviceId !== 'string' ||
    typeof group.epoch !== 'number' ||
    !Array.isArray(group.devices)
  ) {
    throw new SyncError('syncErrorResponse')
  }
  const devices: GroupDevice[] = []
  for (const item of group.devices) {
    const device = asObject(item)
    if (typeof device.id !== 'string' || typeof device.name !== 'string') {
      continue
    }
    devices.push({
      id: device.id,
      name: device.name,
      canHost: device.canHost === true,
      joinedAt: typeof device.joinedAt === 'number' ? device.joinedAt : 0,
      lastSeenAt: typeof device.lastSeenAt === 'number' ? device.lastSeenAt : null,
    })
  }
  return {
    groupId: group.groupId,
    groupName: group.groupName,
    hostDeviceId: group.hostDeviceId,
    epoch: group.epoch,
    createdAt: typeof group.createdAt === 'number' ? group.createdAt : 0,
    devices,
  }
}

const parseInvite = (value: unknown): InviteInfo => {
  const invite = asObject(value)
  if (typeof invite.code !== 'string' || typeof invite.expiresAt !== 'number') {
    throw new SyncError('syncErrorResponse')
  }
  return { code: invite.code, expiresAt: invite.expiresAt }
}

/** 读组信息；服务端还没建组时返回 null */
export const fetchGroup = async (serverUrl: string): Promise<GroupInfo | null> => {
  const body = asObject(await request(serverUrl + '/api/group'))
  return body.group == null ? null : parseGroup(body.group)
}

/** 第一台设备创建组，返回设备令牌与一次性配对码 */
export const createGroup = async (
  serverUrl: string,
  input: { device: string; name: string; groupName?: string; canHost?: boolean }
): Promise<CreateGroupResult> => {
  const body = asObject(
    await request(serverUrl + '/api/group/create', { body: input })
  )
  return {
    group: parseGroup(body.group),
    deviceToken: typeof body.deviceToken === 'string' ? body.deviceToken : '',
    invite: parseInvite(body.invite),
  }
}

/** 用配对码加入组 */
export const joinGroup = async (
  serverUrl: string,
  input: { code: string; device: string; name: string; canHost?: boolean }
): Promise<JoinGroupResult> => {
  const body = asObject(await request(serverUrl + '/api/group/join', { body: input }))
  return {
    group: parseGroup(body.group),
    deviceToken: typeof body.deviceToken === 'string' ? body.deviceToken : '',
  }
}

/** 主机生成新的配对码 */
export const createInvite = async (serverUrl: string, token: string): Promise<InviteInfo> => {
  const body = asObject(
    await request(serverUrl + '/api/group/invite', {
      token,
      body: { device: 'host' },
    })
  )
  return parseInvite(body.invite)
}

/** 更换主机；epoch 用于乐观并发 */
export const transferHost = async (
  serverUrl: string,
  token: string,
  device: string,
  targetDeviceId: string,
  epoch: number
): Promise<GroupInfo> => {
  const body = asObject(
    await request(serverUrl + '/api/group/host', {
      token,
      body: { device, targetDeviceId, epoch },
    })
  )
  return parseGroup(body.group)
}

/** 主机移除成员 */
export const revokeDevice = async (
  serverUrl: string,
  token: string,
  targetDeviceId: string
): Promise<GroupInfo> => {
  const body = asObject(
    await request(serverUrl + '/api/group/revoke', {
      token,
      body: { targetDeviceId },
    })
  )
  return parseGroup(body.group)
}

