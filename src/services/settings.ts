import { create } from 'zustand'
import { createId } from '../utils/id.js'
// 只取类型：i18n 反向依赖本模块的 useSettings，用 import type 避免运行时循环引用
import type { TranslationKey } from '../i18n/index.js'
import type { ReasoningEffort } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { sanitizeSyncedSettings, type SyncedSettings } from './sync/protocol.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 全局字号档位；normal 用 theme.css 里的基础值，small / large 由
 * body[data-font-scale] 覆盖 --ds-fs-* 与 --ds-lh-*（0.9 / 1.1 倍）。
 */
export type FontScale = 'small' | 'normal' | 'large'

/** 字号默认档位：不写 data-font-scale，直接用基础值 */
export const DEFAULT_FONT_SCALE: FontScale = 'normal'

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

/**
 * 字号三档的展示顺序与文案 key：设置面板用这份顺序，避免与其它选择项不一致。
 * 与 REASONING_EFFORT_OPTIONS 一样放在本模块，界面只负责翻译。
 */
export const FONT_SCALE_OPTIONS: { value: FontScale; label: TranslationKey }[] = [
  { value: 'small', label: 'settingsFontScaleSmall' },
  { value: 'normal', label: 'settingsFontScaleNormal' },
  { value: 'large', label: 'settingsFontScaleLarge' },
]

/** 多端同步的默认服务地址：与 `sync-server/server.mjs` 的默认端口一致 */
export const DEFAULT_SYNC_SERVER = 'https://127.0.0.1:7788'

/**
 * 本机设置，存 localStorage：API Key、语言、主题、字号、位置、模型、推理强度、
 * 深度思考与智能搜索开关、侧边栏收起状态、多端同步的服务地址与设备身份。
 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  /** 全局字号档位，只影响界面字号，不参与请求 */
  fontScale: FontScale
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
  /** 设备名，只用于界面展示与本机识别，不参与冲突判定，也不参与同步（见 sync/protocol.ts） */
  syncDeviceName: string
  /** 设备 id：首次启动生成并固定，冲突时用于 tie-break，用户不可改 */
  syncDeviceId: string
  /** 组 ID / 组名；空串表示还没加入组 */
  syncGroupId: string
  syncGroupName: string
  /** 本机在组里的设备令牌；只在创建/加入时拿到一次 */
  syncGroupToken: string
  /** 当前主机设备 id 与组 epoch；换主机后由服务端返回 */
  syncGroupHostId: string
  syncGroupEpoch: number
  /** 本机是否声明可以当主机（手机为 false） */
  syncGroupCanHost: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  fontScale: 'chat-demo:font-scale',
  model: 'chat-demo:model',
  reasoningEffort: 'chat-demo:reasoning-effort',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  syncServerUrl: 'chat-demo:sync-server',
  syncDeviceName: 'chat-demo:sync-device-name',
  syncDeviceId: 'chat-demo:sync-device-id',
  syncGroupId: 'chat-demo:sync-group-id',
  syncGroupName: 'chat-demo:sync-group-name',
  syncGroupToken: 'chat-demo:sync-group-token',
  syncGroupHostId: 'chat-demo:sync-group-host-id',
  syncGroupEpoch: 'chat-demo:sync-group-epoch',
  syncGroupCanHost: 'chat-demo:sync-group-can-host',
  /** 设置的「最后修改时间」（毫秒），多端同步用它做整份 LWW 的时间戳 */
  settingsUpdatedAt: 'chat-demo:settings-updated-at',
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

const isFontScale = (value: string | null): value is FontScale =>
  value === 'small' || value === 'normal' || value === 'large'

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

/** 未保存过（或保存值不可识别）时用标准档 */
const initialFontScale = (): FontScale => {
  const saved = read(KEYS.fontScale)
  return isFontScale(saved) ? saved : DEFAULT_FONT_SCALE
}

/**
 * 读一份完整设置（模块初始化与「同步落地后重载」共用同一套读取逻辑）。
 * 两边共用是刻意的：内存里的值必须与「刷新页面后读到的值」逐字段相同，
 * 否则同步的指纹会与落地内容对不上，两端会来回推同一份设置。
 *
 * @returns 从 localStorage 读出的设置（缺省值见各 initial* 函数）
 */
const readSettings = (): Settings => ({
  apiKey: initialApiKey(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  fontScale: initialFontScale(),
  model: initialModel(),
  reasoningEffort: initialReasoningEffort(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  syncServerUrl: read(KEYS.syncServerUrl)?.trim() ?? '',
  syncDeviceName: initialSyncDeviceName(),
  syncDeviceId: initialSyncDeviceId(),
  syncGroupId: read(KEYS.syncGroupId)?.trim() ?? '',
  syncGroupName: read(KEYS.syncGroupName)?.trim() ?? '',
  syncGroupToken: read(KEYS.syncGroupToken)?.trim() ?? '',
  syncGroupHostId: read(KEYS.syncGroupHostId)?.trim() ?? '',
  syncGroupEpoch: Math.max(0, Math.floor(Number(read(KEYS.syncGroupEpoch)) || 0)),
  syncGroupCanHost: read(KEYS.syncGroupCanHost) === 'true',
})

export const useSettings = create<Settings>(() => readSettings())

/**
 * 按 localStorage 现状重载设置。
 * 同步把远端设置写进 localStorage 之后必须调用，否则界面要等刷新才变。
 *
 * @sideeffect 覆盖 useSettings 的全部字段（apiKey / syncDeviceId 也一起按存储重读，
 *   但它们的存储值没被同步改过，因此实际不变）
 */
export const reloadSettingsFromStorage = (): void => {
  useSettings.setState(readSettings())
}

/** 非负整数时间戳；坏值一律当作「没改过」 */
const readStamp = (value: string | null): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

/** 设置的最后修改时间（毫秒）；0 表示从没改过（同步时总是输给对端那份） */
export const loadSettingsUpdatedAt = (): number => readStamp(read(KEYS.settingsUpdatedAt))

/**
 * 记一次设置修改。
 * 单调递增：取 max(现在, 上次 + 1)，时钟回拨或与远端同一毫秒都不会让新改动变「更旧」。
 *
 * @sideeffect 写 chat-demo:settings-updated-at
 */
const touchSettingsUpdatedAt = (): void => {
  write(KEYS.settingsUpdatedAt, String(Math.max(Date.now(), loadSettingsUpdatedAt() + 1)))
}

/**
 * 本机可同步的那份设置（整份一条记录的内容）。
 *
 * 从当前状态取值后过一遍 sanitizeSyncedSettings：它按白名单逐字段重建，
 * apiKey、syncDeviceId、syncDeviceName 与 LAN 相关键因此不可能混进同步记录
 * （不是「记得删」，而是「装不进」）。
 *
 * @returns 可同步设置；理论上不会是 null（状态字段本身合法），null 时本次不产出设置记录
 */
export const loadSyncedSettings = (): SyncedSettings | null => {
  const state = useSettings.getState()
  return sanitizeSyncedSettings({
    locale: state.locale,
    themePreference: state.themePreference,
    fontScale: state.fontScale,
    location: state.location,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    thinking: state.thinking,
    search: state.search,
    siderCollapsed: state.siderCollapsed,
    syncServerUrl: state.syncServerUrl,
  })
}

/** 用于「落地后是否真的变了」的比较串（不含 apiKey：它不参与同步） */
const canonicalSettings = (): string => {
  const data = loadSyncedSettings()
  return data === null ? '' : JSON.stringify(data)
}

/**
 * 把远端赢的设置整份落到本机。
 *
 * 只写白名单里的十个键（语言、主题、字号、位置、模型、推理强度、深度思考、智能搜索、
 * 侧边栏、同步服务地址）：apiKey、syncDeviceId、syncDeviceName 与 LAN 相关键
 * （lan-enabled / lan-key / lan-pair-tag / lan-peers）不在这份数据里，也没有对应的写操作，
 * 远端值永远盖不到它们 —— 设备名是本机身份，尤其不能被对端改名。
 * 落地时间写成远端那条记录的时间（不是 now）：本机这份内容确实「最后改于」那个时刻，
 * 下次同步才不会把它当成新改动再推回去。
 *
 * @param data 已校验的可同步设置
 * @param updatedAt 这条设置记录的时间
 * @returns 内存里的设置是否真的发生了变化
 * @sideeffect 写 localStorage 并重载 useSettings
 */
export const applySyncedSettings = (data: SyncedSettings, updatedAt: number): boolean => {
  const before = canonicalSettings()
  const location = normalizeLocation(data.location)
  write(KEYS.locale, data.locale)
  write(KEYS.themePreference, data.themePreference)
  write(KEYS.fontScale, data.fontScale)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  write(KEYS.model, data.model)
  write(KEYS.reasoningEffort, data.reasoningEffort)
  write(KEYS.thinking, String(data.thinking))
  write(KEYS.search, String(data.search))
  write(KEYS.siderCollapsed, String(data.siderCollapsed))
  write(KEYS.syncServerUrl, data.syncServerUrl || null)
  // 设备名不写：它不在远端记录里（白名单已排除），本机名字只由 setSyncDeviceName 改
  write(KEYS.settingsUpdatedAt, String(Math.max(0, Math.floor(updatedAt))))
  reloadSettingsFromStorage()
  return canonicalSettings() !== before
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  touchSettingsUpdatedAt()
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  touchSettingsUpdatedAt()
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  touchSettingsUpdatedAt()
  useSettings.setState({ themePreference })
}

/**
 * 保存字号档位。
 * 与主题一样属于可同步设置：写盘后刷新「设置最后修改时间」，
 * 落地由 app/theme.ts 的订阅负责，这里只管状态。
 */
export const setFontScale = (fontScale: FontScale) => {
  write(KEYS.fontScale, fontScale)
  touchSettingsUpdatedAt()
  useSettings.setState({ fontScale })
}

/**
 * 保存 API Key。
 * 刻意不刷新「设置最后修改时间」：apiKey 不在同步范围内，改它不该让整份设置变新，
 * 否则只改本机 key 也会把对端的其它设置项压掉。
 */
export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setModel = (model: string) => {
  const value = model.trim() || DEFAULT_MODEL
  write(KEYS.model, value)
  touchSettingsUpdatedAt()
  useSettings.setState({ model: value })
}

/** 只改强度档位；开关状态独立保存，关闭思考不会覆盖这里的选择 */
export const setReasoningEffort = (reasoningEffort: ReasoningEffort) => {
  write(KEYS.reasoningEffort, reasoningEffort)
  touchSettingsUpdatedAt()
  useSettings.setState({ reasoningEffort })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  touchSettingsUpdatedAt()
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  touchSettingsUpdatedAt()
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  touchSettingsUpdatedAt()
  useSettings.setState({ siderCollapsed })
}

/** 保存同步服务地址；空串表示清除配置（「测试连接」「同步」会提示先填地址） */
export const setSyncServerUrl = (url: string) => {
  const value = url.trim()
  write(KEYS.syncServerUrl, value || null)
  touchSettingsUpdatedAt()
  useSettings.setState({ syncServerUrl: value })
}

/** 组信息的最小形状；避免 settings 反向依赖 sync/api */
export type SyncGroupState = {
  groupId: string
  groupName: string
  hostDeviceId: string
  epoch: number
}

/**
 * 落地一次组状态（创建、加入、换主机后调用）。
 *
 * @param group 服务端返回的组状态
 * @param token 新设备令牌；只在创建/加入时传，换主机时省略
 */
export const saveSyncGroup = (group: SyncGroupState, token?: string) => {
  write(KEYS.syncGroupId, group.groupId)
  write(KEYS.syncGroupName, group.groupName)
  write(KEYS.syncGroupHostId, group.hostDeviceId)
  write(KEYS.syncGroupEpoch, String(group.epoch))
  if (token) {
    write(KEYS.syncGroupToken, token)
  }
  useSettings.setState({
    syncGroupId: group.groupId,
    syncGroupName: group.groupName,
    syncGroupHostId: group.hostDeviceId,
    syncGroupEpoch: group.epoch,
    ...(token ? { syncGroupToken: token } : {}),
  })
}

/** 退出组：清掉组 ID、令牌与主机信息；服务地址保留 */
export const clearSyncGroup = () => {
  for (const key of [
    KEYS.syncGroupId,
    KEYS.syncGroupName,
    KEYS.syncGroupToken,
    KEYS.syncGroupHostId,
    KEYS.syncGroupEpoch,
  ]) {
    write(key, null)
  }
  useSettings.setState({
    syncGroupId: '',
    syncGroupName: '',
    syncGroupToken: '',
    syncGroupHostId: '',
    syncGroupEpoch: 0,
  })
}

/** 本机是否可当主机；手机端为 false */
export const setSyncGroupCanHost = (value: boolean) => {
  write(KEYS.syncGroupCanHost, String(value))
  useSettings.setState({ syncGroupCanHost: value })
}

/**
 * 保存设备名；清空时回退到默认名，保证列表里始终有名字可显示。
 *
 * 刻意不刷新「设置最后修改时间」，理由同 setApiKey：设备名不在同步范围内
 * （见 sync/protocol.ts 的白名单），改它不该让整份设置变新，
 * 否则只改本机名字也会把对端的其它设置项压掉。
 */
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
