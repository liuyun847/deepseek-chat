import { create } from 'zustand'
import type { TranslationKey } from '../i18n/index.js'

/**
 * 本机 Web 服务（local-server/）探测。
 *
 * 为什么运行时探测、而不是再加一个构建开关：同一份 dist/ 要同时喂给浏览器和 APK
 * （见 README「安卓 APK」），多一套产物就多一处会漂的差异。页面由本机服务托管时
 * API 走同源反向代理 /anthropic/*，key 由服务端注入；APK（https://dsapp.local）
 * 与 file:// 下探测直接返回 false，请求照旧打到构建期注入的 __API_ORIGIN__。
 *
 * 探测只在回环地址上发：本机服务只监听 127.0.0.1（见 local-server/server.mjs 的
 * 启动检查），别处不可能有它，也就没必要为一次注定失败的请求付延迟。
 */

/** /api/health 里的服务标识：确认对面是本机服务，而不是别的程序恰好占了这个路径 */
const SERVICE_ID = 'deepseek-chat-local'

/** 只在这些 host 上探测；APK 的页面源是 dsapp.local，file:// 下压根没有 host */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 本机服务的状态：是否由它托管本页、它有没有配置 key、产物里有没有烘进 key */
export type LocalServiceState = {
  /** 页面由本机服务供给：API 用相对路径走同源代理，浏览器不携带鉴权头 */
  active: boolean
  /** 服务端是否已配置 API key；false 时代理路由回 503 */
  keyConfigured: boolean
  /** dist/ 里带着构建期注入的真实 key（那是给 APK 用的构建，网页版应改用 build:web） */
  distHasBakedKey: boolean
}

const IDLE: LocalServiceState = { active: false, keyConfigured: false, distHasBakedKey: false }

/** 给 React 用的响应式副本：设置面板要按它换文案 */
export const useLocalService = create<LocalServiceState>(() => IDLE)

/** 给非组件代码用的同步快照；探测完成前是 IDLE */
let current: LocalServiceState = IDLE

/**
 * 当前是否由本机服务托管本页。
 *
 * @returns 探测到本机服务时为 true（探测完成前恒为 false）
 */
export const isLocalService = (): boolean => current.active

/**
 * 探测 GET /api/health，只认带服务标识的 JSON 响应。
 *
 * @returns 命中本机服务时为 true；非回环来源、请求失败、响应不是本服务都返回 false
 * @sideeffect 命中时更新模块快照与 useLocalService
 */
const probe = async (): Promise<boolean> => {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) {
    return false
  }
  if (!LOOPBACK_HOSTS.has(location.hostname)) {
    return false
  }
  try {
    const response = await fetch('/api/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
    })
    if (!response.ok) {
      return false
    }
    const body = (await response.json()) as {
      service?: unknown
      keyConfigured?: unknown
      distHasBakedKey?: unknown
    } | null
    if (body?.service !== SERVICE_ID) {
      return false
    }
    current = {
      active: true,
      keyConfigured: body.keyConfigured === true,
      distHasBakedKey: body.distHasBakedKey === true,
    }
    useLocalService.setState(current)
    return true
  } catch {
    return false
  }
}

/**
 * 探测只跑一次。API 请求（api/client.ts）、模型列表、设置面板都等这个 Promise，
 * 避免「先发了请求、后才知道该走代理」。
 */
export const localServiceReady: Promise<boolean> = probe()

/**
 * 「本机服务自己的问题」的文案键。
 *
 * 这两个不是上游 API 的错误：未启动是浏览器连不上本机服务，未配置 key 是本机服务
 * 回 503。展示时不再按状态码归类 —— 否则 503 会被套成「服务繁忙」，用户看不出
 * 到底该去配 key 还是该去启动脚本。
 */
export const LOCAL_SERVICE_NOTICE_KEYS: readonly TranslationKey[] = [
  'localServiceOffline',
  'localServiceNoKey',
]
