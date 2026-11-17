import {
  LanCryptoError,
  MIN_PASSPHRASE_LENGTH,
  deriveKeyBytes,
  fromBase64,
  pairTagOf,
  toBase64,
} from './crypto.js'

/**
 * 手机直连的本机配置：开关、配对密钥、口令指纹、每个对端的上次同步时间。
 *
 * 为什么存「派生后的密钥」而不是口令
 * ============================
 * 口令是用户可能复用到别处的短秘密；存进 localStorage 等于让它常驻 WebView 存储。
 * 这里只存 PBKDF2 派生出的 32 字节密钥（base64），够用且更窄：泄露的是这一对设备的
 * 通信密钥，不是口令本身。代价是「改口令」必须重新输入（符合预期）。
 *
 * 与多端同步的 settings.ts 分开：那边是 HTTP 通道的配置（服务地址、设备 id），
 * 这条链路独立开关、独立清理，互不影响（约束里要求「不改现有 HTTP 同步」）。
 */

const KEYS = {
  /** 'true' / 空 */
  enabled: 'chat-demo:lan-enabled',
  /** base64 的 32 字节密钥 */
  key: 'chat-demo:lan-key',
  /** 口令指纹（12 位十六进制） */
  pairTag: 'chat-demo:lan-pair-tag',
  /** JSON：{ deviceId: { pairTag, lastSyncAt } } */
  peers: 'chat-demo:lan-peers',
} as const

/** 一次配对的结果 */
export type LanCredentials = { keyBase64: string; pairTag: string }

/** 一个对端的历史记录（只用于界面展示「上次同步」） */
export type LanPeerHistory = { pairTag: string; lastSyncAt: number }

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null): void => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存里生效（本次会话仍可用）
  }
}

/** 是否开启了手机直连（默认关闭：这是会广播设备名的功能，必须用户显式打开） */
export const isLanEnabled = (): boolean => read(KEYS.enabled) === 'true'

export const setLanEnabled = (enabled: boolean): void => {
  write(KEYS.enabled, enabled ? 'true' : null)
}

/**
 * 读本机配对密钥。
 *
 * @returns 密钥与指纹；没配对过、或存的东西已损坏时返回 null
 */
export const loadCredentials = (): LanCredentials | null => {
  const keyBase64 = read(KEYS.key)
  const pairTag = read(KEYS.pairTag)
  if (!keyBase64 || !pairTag) {
    return null
  }
  try {
    if (fromBase64(keyBase64).length !== 32) {
      return null
    }
  } catch {
    return null
  }
  return { keyBase64, pairTag }
}

/** base64 密钥 → 原始字节（调用方需先确认 loadCredentials 非空） */
export const keyBytesOf = (credentials: LanCredentials): Uint8Array =>
  fromBase64(credentials.keyBase64)

/**
 * 用口令配对：派生密钥并落盘。
 *
 * @param passphrase 用户输入的口令（会先去掉首尾空白）
 * @returns 新密钥与指纹
 * @throws LanCryptoError code 为 short（口令太短）或 unsupported（没有 WebCrypto）
 */
export const pairWithPassphrase = async (passphrase: string): Promise<LanCredentials> => {
  const value = passphrase.trim()
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    throw new LanCryptoError('short')
  }
  const bytes = await deriveKeyBytes(value)
  const credentials: LanCredentials = { keyBase64: toBase64(bytes), pairTag: await pairTagOf(bytes) }
  write(KEYS.key, credentials.keyBase64)
  write(KEYS.pairTag, credentials.pairTag)
  return credentials
}

/** 忘掉配对（密钥与指纹一起清掉；开关状态保留） */
export const clearCredentials = (): void => {
  write(KEYS.key, null)
  write(KEYS.pairTag, null)
  write(KEYS.peers, null)
}

/** 读对端历史；坏数据一律当作空 */
export const loadPeerHistory = (): Record<string, LanPeerHistory> => {
  const raw = read(KEYS.peers)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const result: Record<string, LanPeerHistory> = {}
    for (const [deviceId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        continue
      }
      const item = value as Record<string, unknown>
      result[deviceId] = {
        pairTag: typeof item.pairTag === 'string' ? item.pairTag : '',
        lastSyncAt: typeof item.lastSyncAt === 'number' ? item.lastSyncAt : 0,
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 记一次成功同步（对端 deviceId + 当时的指纹 + 时间）。
 *
 * @param deviceId 对端设备 id
 * @param pairTag 对端口令指纹（变了说明对方换了口令，历史自然作废）
 * @param at 同步时刻
 */
export const rememberPeerSync = (deviceId: string, pairTag: string, at: number): void => {
  const history = loadPeerHistory()
  history[deviceId] = { pairTag, lastSyncAt: at }
  write(KEYS.peers, JSON.stringify(history))
}
