import { create } from 'zustand'
import type { TranslationKey } from '../../../i18n/index.js'
import { useChatStore } from '../../chat/store.js'
import { useSettings } from '../../settings.js'
import {
  LanError,
  installHandlers,
  lanAvailability,
  readPeers,
  replyNative,
  sendNative,
  startNative,
  stopNative,
  takeInbox,
  type LanSelf,
} from './bridge.js'
import { LanCryptoError, importLanKey, openMessage, sealMessage } from './crypto.js'
import { commitReply, readLocalState, serveIncoming, syncBlockedReason } from './exchange.js'
import {
  LAN_FORMAT,
  LAN_MAX_BYTES,
  LAN_PROTO,
  createRequestId,
  envelopeAad,
  parseEnvelope,
  parseMessage,
  stampOf,
  statsOf,
  type LanEnvelope,
  type LanMessage,
} from './protocol.js'
import {
  clearCredentials,
  isLanEnabled,
  keyBytesOf,
  loadCredentials,
  loadPeerHistory,
  pairWithPassphrase,
  rememberPeerSync,
  setLanEnabled,
} from './settings.js'

/**
 * 手机直连的编排层：发现 → 配对 → 自动同步 → 落地。
 *
 * 与 HTTP 通道的分工
 * =================
 * 合并规则、加密格式、墓碑语义都不是这里写的：合并走 transfer.ts（最终落到 merge.ts 的
 * applyPulledRecords），加密走 crypto.ts，记录结构走 ../protocol.ts。这一层只做四件事：
 *   1. 把原生发现到的设备映射成界面状态（谁在线、谁和我同口令）；
 *   2. 收/发加密信封（who 发给谁、怎么回）；
 *   3. 调度：什么时候同步、谁先发起、多久一次；
 *   4. 把结果记成「上次同步」，供设置页展示。
 *
 * 谁先发起（避免两端同时打）
 * =====================
 * deviceId 字典序小的一方负责主动同步；大的一方只应答，需要对方来拉时发一个 ping
 * （「我这边有新东西，你来同步」）。这样任意时刻只有一条同步在跑，口子也不依赖时钟。
 * 手动「立即同步」不受这条限制（用户按了就得动）。
 */

/** 定期巡检间隔：只做 hello 比版本，一致就结束，几乎不耗流量 */
const TICK_MS = 45_000

/** 同一个对端的自动同步最小间隔（防止广播频率带着同步频率跑） */
const AUTO_MIN_INTERVAL_MS = 10_000

/** 给对端发「来拉我」的 ping 的最小间隔 */
const NUDGE_MIN_INTERVAL_MS = 8_000

/** 本地改动后延迟多久自动同步（攒一下连续输入） */
const CHANGE_DEBOUNCE_MS = 4000

/** 记住的请求 id 上限，用于丢弃重放 */
const SEEN_LIMIT = 64

/** 直连的状态机：off 未开启 / unsupported 环境不支持 / starting 正在起 / waiting 起好了但没配对的在线 / running 有已配对设备 / error 起不来 */
export type LanStatus = 'off' | 'unsupported' | 'starting' | 'waiting' | 'running' | 'error'

/** 界面上的一台对端 */
export type LanPeerView = {
  deviceId: string
  name: string
  host: string
  port: number
  /** 对端口令指纹 */
  pairTag: string
  paired: boolean
  lastSyncAt: number
  syncing: boolean
}

/** 一次同步的结果（跨刷新展示） */
export type LanSyncSummary = {
  at: number
  ok: boolean
  /** 对端设备名 */
  peer: string
  /** 本地被对端采纳的记录数（应答方视角是回给对方的差异条数） */
  pushed: number
  /** 从对端拉回的记录数 */
  pulled: number
  /** 本地实际写入/删除的会话数 */
  applied: number
  reason?: TranslationKey
  message?: string
}

type LanState = {
  status: LanStatus
  /** 用户是否打开了开关 */
  enabled: boolean
  /** 是否已设口令 */
  hasKey: boolean
  pairTag: string
  self: LanSelf | null
  peers: LanPeerView[]
  lastSync: LanSyncSummary | null
  /** 正在同步（界面禁用按钮） */
  busy: boolean
  /** 自检结果（一次性） */
  selfTest: { ok: boolean; detail: string } | null
  testing: boolean
  error: TranslationKey | null
}

export const useLan = create<LanState>(() => ({
  status: 'off',
  enabled: false,
  hasKey: false,
  pairTag: '',
  self: null,
  peers: [],
  lastSync: null,
  busy: false,
  selfTest: null,
  testing: false,
  error: null,
}))

/** 流程层的可预期错误（带文案 key），与 HTTP 通道的 SyncError 分开 */
class FlowError extends Error {
  readonly key: TranslationKey

  constructor(key: TranslationKey, detail?: string) {
    super(detail ?? key)
    this.name = 'FlowError'
    this.key = key
  }
}

// ── 模块内状态（不进 React 状态：密钥、去重窗口、节流表都不需要触发渲染） ──────

let key: CryptoKey | null = null
let running = false
let started = false
let changeTimer: number | null = null

const seenIds = new Set<string>()
const lastAuto = new Map<string, number>()
const lastNudge = new Map<string, number>()
const inFlight = new Set<string>()

/** 串行化同步：同一页面同一时刻只跑一条链路（跨设备靠 deviceId 大小决定谁发起） */
let chain: Promise<unknown> = Promise.resolve()

const serialize = <T>(task: () => Promise<T>): Promise<T> => {
  const next = chain.then(task, task)
  chain = next.catch(() => undefined)
  return next
}

const deviceId = (): string => useSettings.getState().syncDeviceId
const deviceName = (): string => useSettings.getState().syncDeviceName

/**
 * 把异常翻译成文案 key。
 *
 * @param error 任意异常
 * @returns 界面用的文案 key
 */
const errorKey = (error: unknown): TranslationKey => {
  if (error instanceof FlowError) {
    return error.key
  }
  if (error instanceof LanCryptoError) {
    if (error.code === 'auth') {
      return 'lanErrorAuth'
    }
    if (error.code === 'too-large') {
      return 'lanErrorTooLarge'
    }
    if (error.code === 'unsupported') {
      return 'lanErrorUnsupported'
    }
    return 'lanErrorFormat'
  }
  if (error instanceof LanError) {
    if (error.code === 'timeout') {
      return 'lanErrorTimeout'
    }
    if (error.code === 'network') {
      return 'lanErrorNetwork'
    }
    if (error.code === 'bridge' || error.code === 'start') {
      return 'lanErrorBridge'
    }
    return 'lanErrorUnknown'
  }
  return 'lanErrorUnknown'
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? (error.message ?? '') : String(error)

const rememberSeen = (id: string): void => {
  seenIds.add(id)
  while (seenIds.size > SEEN_LIMIT) {
    const first = seenIds.values().next()
    if (first.done === true) {
      break
    }
    seenIds.delete(first.value)
  }
}

// ── 信封收发 ────────────────────────────────────────────────────────────────

type Opened =
  | { ok: true; env: LanEnvelope; message: LanMessage }
  | { ok: false; reason: TranslationKey }

/**
 * 解一个信封：格式 → 时间窗口 → 去重 → 解密（AES-GCM 校验）→ 结构校验。
 *
 * @param text 收到的信封 JSON 原文
 * @returns 成功时带信封与消息；失败时带文案 key
 */
const openEnvelopeText = async (text: string): Promise<Opened> => {
  if (text.length > LAN_MAX_BYTES * 2) {
    return { ok: false, reason: 'lanErrorTooLarge' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'lanErrorFormat' }
  }
  const env = parseEnvelope(parsed, Date.now())
  if (!env) {
    return { ok: false, reason: 'lanErrorFormat' }
  }
  if (seenIds.has(env.id)) {
    // 重放或重复投递：静默丢弃（界面不报错，否则对端重发会刷屏）
    return { ok: false, reason: 'lanErrorReplay' }
  }
  rememberSeen(env.id)
  if (!key) {
    return { ok: false, reason: 'lanErrorNoKey' }
  }
  let body: unknown
  try {
    body = await openMessage(key, envelopeAad(env), { iv: env.iv, data: env.data })
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof LanCryptoError && error.code === 'auth' ? 'lanErrorAuth' : 'lanErrorFormat',
    }
  }
  const message = parseMessage(body)
  if (!message) {
    return { ok: false, reason: 'lanErrorFormat' }
  }
  return { ok: true, env, message }
}

/**
 * 把消息封成信封 JSON。
 *
 * @param id 请求 id（同时参与 AAD，回复方原样带回前必须先对上号）
 * @param message 要发送的消息
 * @returns 信封 JSON
 */
const sealEnvelopeText = async (id: string, message: LanMessage): Promise<string> => {
  if (!key) {
    throw new FlowError('lanErrorNoKey')
  }
  const ts = Date.now()
  const sealed = await sealMessage(key, envelopeAad({ from: deviceId(), id, ts }), message)
  return JSON.stringify({
    format: LAN_FORMAT,
    proto: LAN_PROTO,
    from: deviceId(),
    id,
    ts,
    iv: sealed.iv,
    data: sealed.data,
  })
}

/** 一台对端的连接信息 */
type PeerTarget = { deviceId: string; name: string; host: string; port: number; pairTag: string }

/**
 * 发一个请求并等回复。
 *
 * @param target 对端
 * @param message 请求消息
 * @returns 对端回复的消息
 */
const request = async (target: PeerTarget, message: LanMessage): Promise<LanMessage> => {
  const id = createRequestId()
  const payload = await sealEnvelopeText(id, message)
  const text = await sendNative(id, target.host, target.port, payload)
  const opened = await openEnvelopeText(text)
  if (!opened.ok) {
    throw new FlowError(opened.reason)
  }
  return opened.message
}

/**
 * 回一个收到的请求。
 *
 * @param requestId 原生给的请求 id
 * @param message 回复消息；不给就不回（对端会等到超时）
 */
const replyRequest = async (requestId: string, message: LanMessage): Promise<void> => {
  const payload = await sealEnvelopeText(createRequestId(), message)
  replyNative(requestId, payload)
}

// ── 处理入站请求 ────────────────────────────────────────────────────────────

const recordFailure = (reason: TranslationKey, message?: string): void => {
  useLan.setState({
    lastSync: {
      at: Date.now(),
      ok: false,
      peer: '',
      pushed: 0,
      pulled: 0,
      applied: 0,
      reason,
      message,
    },
  })
}

/**
 * 原生通知「收到一个请求」：取数据 → 解密 → 按消息类型应答。
 *
 * @param requestId 原生给的请求 id
 * @sideeffect 可能写本地会话表（sync 请求）、可能更新界面状态
 */
const handleRequest = async (requestId: string): Promise<void> => {
  const taken = takeInbox(requestId)
  if (!taken || !taken.ok || !taken.payload) {
    if (taken && !taken.ok) {
      recordFailure('lanErrorNetwork', taken.error)
    }
    return
  }
  const opened = await openEnvelopeText(taken.payload)
  if (!opened.ok) {
    if (opened.reason !== 'lanErrorReplay') {
      recordFailure(opened.reason)
    }
    return
  }
  const message = opened.message
  const peerId = message.device
  try {
    if (message.t === 'ping') {
      await replyRequest(requestId, { t: 'ping', device: deviceId(), name: deviceName() })
      // 对端在说「我这边可能有新东西」：轮到我发起时立刻同步一次
      if (isInitiator(peerId)) {
        const peer = findPeer(peerId)
        if (peer && peer.paired) {
          scheduleSync(peer, 0, true)
        }
      }
      return
    }
    if (message.t === 'hello') {
      const state = await readLocalState(deviceId())
      await replyRequest(requestId, {
        t: 'hello',
        device: deviceId(),
        name: deviceName(),
        stamp: stampOf(state.records.values()),
        stats: statsOf(state.records.values()),
      })
      return
    }
    if (message.t === 'sync') {
      const result = await serveIncoming(deviceId(), message.records)
      await replyRequest(requestId, {
        t: 'sync-reply',
        device: deviceId(),
        name: deviceName(),
        records: result.reply,
        received: result.received,
        applied: result.applied,
      })
      const peer = findPeer(peerId)
      if (peer) {
        rememberPeerSync(peer.deviceId, peer.pairTag, Date.now())
      }
      useLan.setState({
        lastSync: {
          at: Date.now(),
          ok: true,
          peer: peer?.name ?? peerId,
          pushed: result.reply.length,
          pulled: result.applied,
          applied: result.applied,
        },
      })
    }
  } catch (error) {
    recordFailure(errorKey(error), detailOf(error))
  }
}

// ── 发起同步 ────────────────────────────────────────────────────────────────

const findPeer = (peerDeviceId: string): LanPeerView | null =>
  useLan.getState().peers.find((peer) => peer.deviceId === peerDeviceId) ?? null

/** deviceId 小的一方负责主动同步（见文件头「谁先发起」） */
const isInitiator = (peerDeviceId: string): boolean => deviceId() < peerDeviceId

/**
 * 跑一轮同步：hello 比版本 → 有差异才推记录 → 落地对方回的差异。
 *
 * @param target 对端
 * @param options.manual 用户手动触发（跳过「必须由我发起」的限制）
 * @returns 本次结果
 * @throws FlowError / LanError / LanCryptoError（调用方决定是否提示）
 */
const syncWithPeer = (target: PeerTarget, options: { manual?: boolean } = {}): Promise<LanSyncSummary> =>
  serialize(async () => {
    if (!key) {
      throw new FlowError('lanErrorNoKey')
    }
    if (!options.manual && !isInitiator(target.deviceId)) {
      throw new FlowError('lanErrorNotInitiator')
    }
    if (inFlight.has(target.deviceId)) {
      throw new FlowError('lanErrorBusy')
    }
    const blocked = syncBlockedReason()
    if (blocked) {
      throw new FlowError(blocked === 'streaming' ? 'syncErrorStreaming' : 'syncErrorImporting')
    }
    inFlight.add(target.deviceId)
    useLan.setState({ busy: true })
    let summary: LanSyncSummary
    try {
      const state = await readLocalState(deviceId())
      const localStamp = stampOf(state.records.values())
      const hello = await request(target, {
        t: 'hello',
        device: deviceId(),
        name: deviceName(),
        stamp: localStamp,
        stats: statsOf(state.records.values()),
      })
      if (hello.t !== 'hello') {
        throw new FlowError('lanErrorFormat')
      }
      if (hello.stamp === localStamp) {
        summary = { at: Date.now(), ok: true, peer: target.name, pushed: 0, pulled: 0, applied: 0 }
      } else {
        const reply = await request(target, {
          t: 'sync',
          device: deviceId(),
          name: deviceName(),
          records: [...state.records.values()],
        })
        if (reply.t !== 'sync-reply') {
          throw new FlowError('lanErrorFormat')
        }
        const result = await commitReply(state, reply.records)
        summary = {
          at: Date.now(),
          ok: true,
          peer: target.name,
          pushed: reply.applied,
          pulled: reply.records.length,
          applied: result.applied,
        }
      }
      rememberPeerSync(target.deviceId, target.pairTag, summary.at)
      useLan.setState({ lastSync: summary, error: null })
      return summary
    } catch (error) {
      summary = {
        at: Date.now(),
        ok: false,
        peer: target.name,
        pushed: 0,
        pulled: 0,
        applied: 0,
        reason: errorKey(error),
        message: detailOf(error),
      }
      useLan.setState({ lastSync: summary, error: summary.reason ?? null })
      throw error
    } finally {
      inFlight.delete(target.deviceId)
      useLan.setState({ busy: false })
      void refreshPeers()
    }
  })

/** 给对端发一个「来拉我」的 ping（对方收到后会立刻发起同步） */
const nudge = async (target: PeerTarget): Promise<void> => {
  if (!key) {
    return
  }
  await request(target, { t: 'ping', device: deviceId(), name: deviceName() })
}

const scheduleSync = (peer: LanPeerView, delayMs: number, force: boolean): void => {
  const now = Date.now()
  if (!force && now - (lastAuto.get(peer.deviceId) ?? 0) < AUTO_MIN_INTERVAL_MS) {
    return
  }
  lastAuto.set(peer.deviceId, now)
  window.setTimeout(() => {
    void syncWithPeer(peer).catch(() => undefined)
  }, delayMs)
}

/** 发现配对设备后的自动行为：我方发起就同步，对方发起就催它一下 */
const autoFor = (peer: LanPeerView): void => {
  if (!key || inFlight.has(peer.deviceId)) {
    return
  }
  if (isInitiator(peer.deviceId)) {
    scheduleSync(peer, 600, false)
    return
  }
  const now = Date.now()
  if (now - (lastNudge.get(peer.deviceId) ?? 0) < NUDGE_MIN_INTERVAL_MS) {
    return
  }
  lastNudge.set(peer.deviceId, now)
  window.setTimeout(() => {
    void nudge(peer).catch(() => undefined)
  }, 600)
}

// ── 状态与开关 ──────────────────────────────────────────────────────────────

/**
 * 从原生读在线设备表并刷新界面状态，顺便触发自动同步。
 *
 * @sideeffect 更新 useLan.peers / status；对已配对设备调度同步或催拉
 */
export const refreshPeers = async (): Promise<void> => {
  if (!running) {
    useLan.setState({ peers: [] })
    return
  }
  const credentials = loadCredentials()
  const tag = credentials?.pairTag ?? ''
  const history = loadPeerHistory()
  const views: LanPeerView[] = readPeers().map((peer) => ({
    deviceId: peer.deviceId,
    name: peer.name,
    host: peer.host,
    port: peer.port,
    pairTag: peer.pairTag,
    paired: tag !== '' && peer.pairTag === tag,
    lastSyncAt: history[peer.deviceId]?.lastSyncAt ?? 0,
    syncing: inFlight.has(peer.deviceId),
  }))
  views.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const state = useLan.getState()
  if (state.status === 'error' || state.status === 'unsupported' || state.status === 'off') {
    useLan.setState({ peers: views })
    return
  }
  useLan.setState({ peers: views, status: views.some((peer) => peer.paired) ? 'running' : 'waiting' })
  for (const peer of views) {
    if (peer.paired) {
      autoFor(peer)
    }
  }
}

/**
 * 启动直连（幂等）。开关没开、或环境不支持时只更新状态，不碰原生。
 *
 * @sideeffect 绑端口、开广播、注册回调
 */
export const startLan = async (): Promise<void> => {
  const availability = lanAvailability()
  const enabled = isLanEnabled()
  const credentials = loadCredentials()
  useLan.setState({
    enabled,
    hasKey: credentials !== null,
    pairTag: credentials?.pairTag ?? '',
  })
  // 能力判断放前面：浏览器（没有原生桥）里应当直接说不可用，而不是摆一个点了没反应的开关
  if (!availability.ready) {
    useLan.setState({
      status: 'unsupported',
      error: availability.native ? 'lanErrorUnsupported' : 'lanErrorBridge',
      self: null,
      peers: [],
    })
    return
  }
  if (!enabled) {
    useLan.setState({ status: 'off', self: null, peers: [] })
    return
  }
  if (running) {
    await refreshPeers()
    return
  }
  useLan.setState({ status: 'starting', error: null })
  try {
    key = credentials ? await importLanKey(keyBytesOf(credentials)) : null
    const self = startNative(deviceId(), deviceName(), credentials?.pairTag ?? '')
    running = true
    installHandlers({
      onPeers: () => {
        void refreshPeers()
      },
      onRequest: (requestId) => {
        void handleRequest(requestId)
      },
    })
    useLan.setState({ status: 'waiting', self, error: null })
    await refreshPeers()
  } catch (error) {
    running = false
    useLan.setState({ status: 'error', error: errorKey(error) })
  }
}

/**
 * 停止直连：关端口、停广播、清掉内存里的密钥与节流表。
 *
 * @sideeffect 原生停止监听；界面回到 off
 */
export const stopLan = (): void => {
  if (running) {
    stopNative()
    running = false
  }
  key = null
  seenIds.clear()
  lastAuto.clear()
  lastNudge.clear()
  inFlight.clear()
  useLan.setState({ status: 'off', self: null, peers: [], busy: false, testing: false })
}

/**
 * 打开/关闭开关。
 *
 * @param enabled true 立即启动；false 立即停止
 */
export const setEnabled = async (enabled: boolean): Promise<void> => {
  setLanEnabled(enabled)
  useLan.setState({ enabled })
  if (enabled) {
    await startLan()
  } else {
    stopLan()
  }
}

/**
 * 用口令配对：派生密钥 → 落盘 → 用新指纹重启广播。
 *
 * @param passphrase 用户输入的口令（至少 8 位）
 * @throws LanCryptoError code 为 short / unsupported
 */
export const pair = async (passphrase: string): Promise<void> => {
  const credentials = await pairWithPassphrase(passphrase)
  setLanEnabled(true)
  useLan.setState({ hasKey: true, pairTag: credentials.pairTag, enabled: true })
  stopLan()
  await startLan()
}

/**
 * 忘掉当前口令（同时关闭开关，避免用空指纹继续广播）。
 *
 * @sideeffect 清 localStorage 里的密钥与对端历史，停止直连
 */
export const forget = (): void => {
  clearCredentials()
  setLanEnabled(false)
  useLan.setState({ hasKey: false, pairTag: '', enabled: false, lastSync: null })
  stopLan()
}

/** 手动同步所有已配对设备（用户按「立即同步」） */
export const syncNow = async (): Promise<void> => {
  const peers = useLan.getState().peers.filter((peer) => peer.paired)
  for (const peer of peers) {
    try {
      await syncWithPeer(peer, { manual: true })
    } catch {
      // 失败已写进 lastSync，继续试下一台
    }
  }
}

// ── 自检（单机验证用） ──────────────────────────────────────────────────────

/**
 * 本机自环自检：向自己的 TCP 端口发一次 ping 和一次 hello，验证
 * 「原生收包 → 页面解密 → 应答加密封回 → 页面收到并解密」整条链路通、且两边数据版本一致。
 *
 * 这是「没有第二台手机」时能对安卓侧做的最强验证：全程走真实 socket、真实加密、真实合并判断。
 *
 * @returns 结果与一行人类可读的诊断信息
 * @sideeffect 更新 useLan.selfTest
 */
export const runSelfTest = async (): Promise<{ ok: boolean; detail: string }> => {
  const self = useLan.getState().self
  if (!self || !running) {
    const detail = 'lan-not-running'
    useLan.setState({ selfTest: { ok: false, detail } })
    return { ok: false, detail }
  }
  useLan.setState({ testing: true })
  const startedAt = Date.now()
  try {
    const target: PeerTarget = {
      deviceId: self.deviceId,
      name: self.name,
      host: '127.0.0.1',
      port: self.port,
      pairTag: self.pairTag,
    }
    const ping = await request(target, { t: 'ping', device: deviceId(), name: deviceName() })
    const echoOk = ping.t === 'ping' && ping.device === deviceId()
    const state = await readLocalState(deviceId())
    const localStamp = stampOf(state.records.values())
    const hello = await request(target, {
      t: 'hello',
      device: deviceId(),
      name: deviceName(),
      stamp: localStamp,
      stats: statsOf(state.records.values()),
    })
    const stampOk = hello.t === 'hello' && hello.stamp === localStamp
    const ok = echoOk && stampOk
    const detail = 'rtt=' + (Date.now() - startedAt) + 'ms echo=' + (echoOk ? 'ok' : 'bad') + ' stamp=' + (stampOk ? 'ok' : 'bad')
    useLan.setState({ selfTest: { ok, detail }, testing: false })
    return { ok, detail }
  } catch (error) {
    const detail = detailOf(error)
    useLan.setState({ selfTest: { ok: false, detail }, testing: false })
    return { ok: false, detail }
  }
}

// ── 生命周期挂钩 ────────────────────────────────────────────────────────────

/** 本地数据变了：攒 4 秒再同步（连续发消息只同步一次） */
const onLocalChange = (): void => {
  if (!running) {
    return
  }
  if (changeTimer !== null) {
    window.clearTimeout(changeTimer)
  }
  changeTimer = window.setTimeout(() => {
    changeTimer = null
    const peers = useLan.getState().peers.filter((peer) => peer.paired)
    for (const peer of peers) {
      if (isInitiator(peer.deviceId)) {
        scheduleSync(peer, 0, true)
      } else {
        void nudge(peer).catch(() => undefined)
      }
    }
  }, CHANGE_DEBOUNCE_MS)
}

/**
 * 装好页面生命周期：可见时启动、不可见时停止（页面关掉广播是硬要求，见任务约束），
 * 本地数据变化自动同步，另有 45 秒一次的版本巡检。
 *
 * @sideeffect 注册 visibilitychange / store 订阅 / 定时器，并立刻尝试启动
 */
export const setupLan = (): void => {
  if (started) {
    return
  }
  started = true
  useLan.setState({
    enabled: isLanEnabled(),
    hasKey: loadCredentials() !== null,
    pairTag: loadCredentials()?.pairTag ?? '',
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void startLan()
    } else {
      stopLan()
    }
  })
  useChatStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) {
      onLocalChange()
    }
  })
  // 定时器不保留句柄：setupLan 只跑一次，页面卸载整个 JS 环境也没了
  window.setInterval(() => {
    if (running) {
      void refreshPeers()
    }
  }, TICK_MS)
  if (document.visibilityState === 'visible') {
    void startLan()
  }
}

/** 给测试/调试用：当前是否在跑（不暴露内部状态对象） */
export const isLanRunning = (): boolean => running
