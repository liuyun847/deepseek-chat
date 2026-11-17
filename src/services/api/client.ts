import { translate, type TranslationMessage } from '../../i18n/index.js'
import { localServiceReady } from '../localService.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  ListModelsResponse,
  MessageStreamEvent,
  ModelInfo,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com（见 rspack.config.ts） */
const BUILTIN_API_ORIGIN = __API_ORIGIN__
/**
 * 接口路径一律写成相对路径，由 request() 拼上实际基址：
 * 页面由本机服务（local-server/）托管时基址是空串 —— 同源反向代理 /anthropic/*，
 * key 由服务端注入；其余场景（APK 的 WebView、file:// 打开、开发服务器）拼 BUILTIN_API_ORIGIN。
 */
const ANTHROPIC_BASE_URL = '/anthropic/v1'
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

/** 本机服务没配 key 时回的错误类型（见 local-server/server.mjs） */
const LOCAL_NO_KEY_TYPE = 'local_service_no_key'

/**
 * 去掉鉴权头。
 *
 * 走本机服务时 key 在服务端，浏览器不该带自己的：带空串会让上游把空串当凭据，
 * 带用户手填的 key 又会和服务端的抢。
 *
 * @param headers 原始请求头
 * @returns 去掉 x-api-key 与 authorization 的副本
 */
const withoutAuth = (headers: HeadersInit | undefined): HeadersInit => {
  const next = new Headers(headers)
  next.delete('x-api-key')
  next.delete('authorization')
  return next
}

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      // 本机服务未配置 key：这不是上游的失败，换成本地文案，
      // 免得 503 被状态码分类改写成「服务繁忙」
      if (body.error.type === LOCAL_NO_KEY_TYPE) {
        return new ApiError(kind, { key: 'localServiceNoKey' }, response.status)
      }
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

/**
 * 发一次 API 请求。
 *
 * @param path 以 / 开头的接口路径，如 `/anthropic/v1/messages`
 * @param init fetch 参数（不含基址）
 * @returns 2xx 的响应
 * @throws ApiError 非 2xx（携带状态码与服务端文案），或请求没送到服务端（network）
 */
export const request = async (path: string, init: RequestInit): Promise<Response> => {
  // 等探测结果：走本机服务时基址为空（同源代理），否则是构建期地址
  const proxied = await localServiceReady
  let response: Response
  try {
    response = await fetch(proxied ? path : BUILTIN_API_ORIGIN + path, {
      ...init,
      ...(proxied ? { headers: withoutAuth(init.headers) } : {}),
    })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    // 页面就是本机服务给的、请求却发不出去：服务已经被停掉了
    if (proxied) {
      throw new ApiError('network', { key: 'localServiceOffline' })
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/**
 * 直连用的鉴权头。走本机服务时 request() 会把它们摘掉（key 由服务端注入），
 * 所以这里不用关心当前是不是代理模式。
 */
const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/**
 * GET /models：获取可用模型列表，同时用于校验 API Key（不产生费用）。
 * 响应形状不符合协议时返回空数组，由调用方回退到内置列表。
 */
export const listModels = async (apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> => {
  const response = await request('/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const body = (await response.json().catch(() => null)) as ListModelsResponse | null
  const data = body?.data
  return Array.isArray(data)
    ? data.filter((model) => typeof model?.id === 'string' && model.id !== '')
    : []
}

/** 校验 API Key：非 2xx 时抛 ApiError，响应内容由 listModels 解析 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await listModels(apiKey, signal)
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${ANTHROPIC_BASE_URL}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
