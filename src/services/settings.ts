import { create } from 'zustand'
import { createId } from '../utils/id.js'
// 只取类型：i18n 反向依赖本模块的 useSettings，用 import type 避免运行时循环引用
import type { TranslationKey } from '../i18n/index.js'
import type { ReasoningEffort } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 默认模型：未选择过、或拉取模型列表失败时使用 */
export const DEFAULT_MODEL = 'deepseek-flash'

/** 推理强度默认档位，与服务端默认一致 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'

/**
 * 推理强度三档的展示顺序与文案 key：设置面板与对话页控制条共用同一份，
 * 避免两处顺序或措辞不一致。
 */
export const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: TranslationKey }[] = [
  { value: 'low', label: 'settingsReasoningEffortLow' },
  { value: 'high', label: 'settingsReasoningEffortHigh' },
  { value: 'max', label: 'settingsReasoningEffortMax' },
]

/** 多端同步的默认服务地址：与 `sync-server/server.mjs` 的默认端口一致 */
export const DEFAULT_SYNC_SERVER = 'http://127.0.0.1:7788'

/**
 * 本机设置，存 localStorage：API Key、语言、主题、位置、模型、推理强度、
 * 深度思考与智能搜索开关、侧边栏收起状态、多端同步的服务地址与设备身份。
 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  /** 全局模型选择（不区分会话），深度思考与智能搜索也是全局粒度 */
  model: string
  /** 推理强度；关闭深度思考时保留用户选择，只是不参与请求 */
  reasoningEffort: ReasoningEffort
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 多端同步服务地址；空串表示还没配置 */
  syncServerUrl: string
  /** 设备名，只用于界面展示与本机识别，不参与冲突判定 */
  syncDeviceName: string
  /** 设备 id：首次启动生成并固定，冲突时用于 tie-break，用户不可改 */
  syncDeviceId: string
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  model: 'chat-demo:model',
  reasoningEffort: 'chat-demo:reasoning-effort',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  syncServerUrl: 'chat-demo:sync-server',
  syncDeviceName: 'chat-demo:sync-device-name',
  syncDeviceId: 'chat-demo:sync-device-id',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/**
 * 内置 API Key：构建期从 .secrets/api-key.txt 注入的常量（见 rspack.config.ts）。
 * 页面里若存在 __DS_CONFIG__ / __DS_CONFIG（壳层注入或外挂 ds-config.js 的形态），优先用它。
 *
 * 两处都没有时返回 null —— 网页与 APK 都回退到「在设置里手动填」的老流程，不会报错。
 *
 * @returns 可用的内置 key，或 null（没有内置）
 */
const builtinApiKey = (): string | null => {
  const scope = globalThis as {
    __DS_CONFIG__?: { apiKey?: unknown }
    __DS_CONFIG?: { apiKey?: unknown }
  }
  const injected = scope.__DS_CONFIG__?.apiKey ?? scope.__DS_CONFIG?.apiKey
  if (typeof injected === 'string' && injected.trim()) {
    return injected.trim()
  }
  // 没有构建期注入时该标识符不存在，typeof 是唯一不会抛错的读法
  const baked = typeof __DS_BUILTIN_API_KEY__ === 'string' ? __DS_BUILTIN_API_KEY__.trim() : ''
  return baked || null
}

/**
 * 当前生效的 key 是否就是内置 key：设置面板据此提示「已内置」，而不是当作没填过。
 *
 * @param apiKey 当前生效的 key
 * @returns 与内置值相同时为 true
 */
export const isBuiltinApiKey = (apiKey: string | null): boolean => {
  const builtin = builtinApiKey()
  return builtin !== null && apiKey === builtin
}

/**
 * 用户手填的 key 优先；localStorage 里没有时才用内置 key。
 * 内置值只存在于内存与构建产物里，不写进 localStorage，也不会被「改 key」清掉。
 *
 * @returns 初始 key，或 null（未配置，界面会引导去设置里填）
 */
const initialApiKey = (): string | null => read(KEYS.apiKey)?.trim() || builtinApiKey()

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

const isReasoningEffort = (value: string | null): value is ReasoningEffort =>
  value === 'low' || value === 'high' || value === 'max'

/** 短随机码：设备 id 与默认设备名的一次性生成 */
const randomSuffix = (length: number) => createId().replace(/-/g, '').slice(0, length)

/**
 * 设备 id 首次启动时生成并落 localStorage。
 * 不能每次刷新重算：它是冲突 tie-break 的依据，变了会让两端对「谁更新」的判断摇摆。
 */
const initialSyncDeviceId = (): string => {
  const saved = read(KEYS.syncDeviceId)?.trim()
  if (saved) {
    return saved
  }
  const id = 'dev-' + randomSuffix(8)
  write(KEYS.syncDeviceId, id)
  return id
}

/** 默认设备名同样只生成一次，之后可在设置里改 */
const initialSyncDeviceName = (): string => {
  const saved = read(KEYS.syncDeviceName)?.trim()
  if (saved) {
    return saved
  }
  const name = (isChineseBrowser() ? '设备-' : 'Device-') + randomSuffix(4)
  write(KEYS.syncDeviceName, name)
  return name
}

/** 未保存过（或保存值不可识别）时用默认模型 */
const initialModel = (): string => read(KEYS.model)?.trim() || DEFAULT_MODEL

const initialReasoningEffort = (): ReasoningEffort => {
  const saved = read(KEYS.reasoningEffort)
  return isReasoningEffort(saved) ? saved : DEFAULT_REASONING_EFFORT
}

export const useSettings = create<Settings>(() => ({
  apiKey: initialApiKey(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  model: initialModel(),
  reasoningEffort: initialReasoningEffort(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  syncServerUrl: read(KEYS.syncServerUrl)?.trim() ?? '',
  syncDeviceName: initialSyncDeviceName(),
  syncDeviceId: initialSyncDeviceId(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setModel = (model: string) => {
  const value = model.trim() || DEFAULT_MODEL
  write(KEYS.model, value)
  useSettings.setState({ model: value })
}

/** 只改强度档位；开关状态独立保存，关闭思考不会覆盖这里的选择 */
export const setReasoningEffort = (reasoningEffort: ReasoningEffort) => {
  write(KEYS.reasoningEffort, reasoningEffort)
  useSettings.setState({ reasoningEffort })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

/** 保存同步服务地址；空串表示清除配置（「测试连接」「同步」会提示先填地址） */
export const setSyncServerUrl = (url: string) => {
  const value = url.trim()
  write(KEYS.syncServerUrl, value || null)
  useSettings.setState({ syncServerUrl: value })
}

/** 保存设备名；清空时回退到默认名，保证列表里始终有名字可显示 */
export const setSyncDeviceName = (name: string) => {
  const value = name.trim()
  if (!value) {
    const fallback = (isChineseBrowser() ? '设备-' : 'Device-') + randomSuffix(4)
    write(KEYS.syncDeviceName, fallback)
    useSettings.setState({ syncDeviceName: fallback })
    return
  }
  write(KEYS.syncDeviceName, value)
  useSettings.setState({ syncDeviceName: value })
}
