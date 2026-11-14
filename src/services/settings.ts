import { create } from 'zustand'
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
 * 本机设置，存 localStorage：API Key、语言、主题、位置、模型、推理强度、
 * 深度思考与智能搜索开关、侧边栏收起状态。
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

/** 未保存过（或保存值不可识别）时用默认模型 */
const initialModel = (): string => read(KEYS.model)?.trim() || DEFAULT_MODEL

const initialReasoningEffort = (): ReasoningEffort => {
  const saved = read(KEYS.reasoningEffort)
  return isReasoningEffort(saved) ? saved : DEFAULT_REASONING_EFFORT
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  model: initialModel(),
  reasoningEffort: initialReasoningEffort(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
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
