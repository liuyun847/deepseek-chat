import type { TranslationKey } from '../../i18n/index.js'
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

  constructor(key: TranslationKey, detail?: string) {
    super(detail ?? key)
    this.name = 'SyncError'
    this.key = key
    this.detail = detail
  }
}

/** 服务地址：允许省略协议（补 http://），去掉结尾斜杠 */
export const normalizeServerUrl = (input: string): string | null => {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return (url.origin + url.pathname).replace(/\/+$/, '')
  } catch {
    return null
  }
}

type RequestOptions = { body?: unknown; timeout?: number }

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
    response = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
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
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      detail = ''
    }
    if (response.status === 404) {
      throw new SyncError('syncErrorNotFound')
    }
    throw new SyncError(
      response.status >= 500 ? 'syncErrorServer' : 'syncErrorResponse',
      detail.slice(0, 200) || String(response.status)
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
export const fetchHealth = async (serverUrl: string): Promise<HealthInfo> => {
  const body = asObject(await request(serverUrl + '/api/health', { timeout: 8000 }))
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
  }
}

/** 拉全量记录（含墓碑） */
export const fetchState = async (serverUrl: string): Promise<SyncRecord[]> => {
  const body = asObject(await request(serverUrl + '/api/state'))
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
  records: SyncRecord[]
): Promise<PushResult> => {
  const body = asObject(
    await request(serverUrl + '/api/sync', {
      body: { format: SYNC_FORMAT, version: SYNC_VERSION, device, records },
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

