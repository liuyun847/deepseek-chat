import { create } from 'zustand'
import type { TranslationKey } from '../../i18n/index.js'
import * as db from '../chat/db.js'
import { flushChatStorage, reloadChatFromStorage, useChatStore } from '../chat/store.js'
import { useSettings } from '../settings.js'
import {
  fetchHealth,
  fetchState,
  normalizeServerUrl,
  pushRecords,
  SyncError,
  type HealthInfo,
} from './api.js'
import {
  applyPulledRecords,
  buildLocalRecords,
  collapseDeletedSessions,
  planMerge,
  recordsToSnapshots,
} from './merge.js'
import { compareRecords, MAX_SYNC_BYTES, recordKey, type SyncRecord } from './protocol.js'
import { loadLastSync, loadSnapshots, saveLastSync, saveSnapshots, type LastSyncInfo } from './snapshots.js'

/** 同步状态：busy 用于禁用按钮，last 用于展示上次结果（页面打开时从记账库读回） */
export type SyncBusy = 'test' | 'sync'

type SyncState = {
  busy: SyncBusy | null
  last: LastSyncInfo | null
}

export const useSync = create<SyncState>(() => ({ busy: null, last: null }))

/** 读设置里的服务地址并规范化；没填或格式不对都当作「先配置」 */
const resolveServer = (): string => {
  const url = normalizeServerUrl(useSettings.getState().syncServerUrl)
  if (!url) {
    throw new SyncError('syncErrorUrl')
  }
  return url
}

/** 首次同步前给用户看的数字：远端有什么、本地有什么 */
export type FirstSyncPreview = {
  server: string
  remoteSessions: number
  remoteMessages: number
  localSessions: number
  localMessages: number
}

/** 数一遍活记录（墓碑不计入） */
const countAlive = (records: SyncRecord[]) => {
  let sessions = 0
  let messages = 0
  for (const record of records) {
    if (record.deletedAt != null) {
      continue
    }
    if (record.kind === 'session') {
      sessions += 1
    } else {
      messages += 1
    }
  }
  return { sessions, messages }
}

/** 页面打开时把上次同步结果读进内存，供设置页展示 */
export const refreshLastSync = async (): Promise<LastSyncInfo | null> => {
  try {
    const info = await loadLastSync()
    useSync.setState({ last: info })
    return info
  } catch {
    // 记账库不可用（隐私模式等）不影响聊天，静默返回
    return null
  }
}

/** 测试连接：探活并读回服务端统计 */
export const testConnection = async (): Promise<HealthInfo> => {
  if (useSync.getState().busy) {
    throw new SyncError('syncErrorBusy')
  }
  const server = resolveServer()
  useSync.setState({ busy: 'test' })
  try {
    return await fetchHealth(server)
  } finally {
    useSync.setState({ busy: null })
  }
}

/**
 * 首次同步的确认数据。
 * 只有「本机从没同步过」且「远端已有记录」时才返回内容，其它情况返回 null（直接同步）。
 */
export const prepareFirstSync = async (): Promise<FirstSyncPreview | null> => {
  const server = resolveServer()
  if (await loadLastSync()) {
    return null
  }
  const remote = countAlive(await fetchState(server))
  if (remote.sessions === 0 && remote.messages === 0) {
    return null
  }
  const sessions = await db.loadAllSessions()
  return {
    server,
    remoteSessions: remote.sessions,
    remoteMessages: remote.messages,
    localSessions: sessions.length,
    localMessages: sessions.reduce((total, session) => total + session.messages.length, 0),
  }
}

/** 估算推送体积（字节级上限，避免把一次请求撑爆） */
const estimatedBytes = (records: SyncRecord[]): number => JSON.stringify(records).length

/**
 * 跑一次完整同步（拉全量 → 逐条合并 → 推送本地胜出的 → 落地远端胜出的）。
 *
 * 失败会写进 last 并抛出 SyncError（界面按 key 翻译提示）。
 * 调用方负责确认「首次同步」已被用户确认（见 prepareFirstSync）。
 */
export const runSync = async (): Promise<LastSyncInfo> => {
  if (useSync.getState().busy) {
    throw new SyncError('syncErrorBusy')
  }
  const chat = useChatStore.getState()
  if (chat.importingHistory) {
    throw new SyncError('syncErrorImporting')
  }
  if (Object.keys(chat.streaming).length > 0) {
    throw new SyncError('syncErrorStreaming')
  }
  const server = resolveServer()
  const device = useSettings.getState().syncDeviceId
  useSync.setState({ busy: 'sync' })
  const at = Date.now()
  try {
    // 界面改的是内存缓存，同步读的是 IndexedDB，先落盘
    await flushChatStorage()
    const sessions = await db.loadAllSessions()
    const snapshots = await loadSnapshots()
    const built = buildLocalRecords({ sessions, snapshots, device, now: Date.now() })

    const remoteRecords = await fetchState(server)
    const remote = new Map(remoteRecords.map((record) => [recordKey(record.kind, record.id), record]))
    const plan = planMerge(built.records, remote)
    if (estimatedBytes(plan.push) > MAX_SYNC_BYTES) {
      throw new SyncError('syncErrorTooLarge')
    }

    // 服务端返回的是「合并后的权威全量」，本地只推自己胜出的那部分
    const result = await pushRecords(server, device, plan.push)
    const finalRecords = new Map(result.records.map((record) => [recordKey(record.kind, record.id), record]))
    for (const [key, record] of built.records) {
      // 理论上服务端一定有这些记录（刚推上去的），兜底防止一次失败把本地记录丢了
      if (!finalRecords.has(key)) {
        finalRecords.set(key, record)
      }
    }
    collapseDeletedSessions(finalRecords)

    const pulled: SyncRecord[] = []
    for (const [key, record] of finalRecords) {
      const local = built.records.get(key)
      if (
        !local ||
        compareRecords(record, local) > 0 ||
        // 会话删除会把它名下的消息墓碑化，此时墓碑的时间戳可能比本地活记录更旧，仍要落地
        (record.deletedAt != null && local.deletedAt == null)
      ) {
        pulled.push(record)
      }
    }

    const applied = applyPulledRecords(sessions, pulled)
    for (const session of applied.upserts) {
      await db.saveSession(session)
    }
    for (const id of applied.removed) {
      await db.deleteSession(id)
    }
    await saveSnapshots(recordsToSnapshots(finalRecords.values()))
    if (applied.upserts.length > 0 || applied.removed.length > 0) {
      await reloadChatFromStorage()
    }

    const info: LastSyncInfo = {
      at,
      ok: true,
      pushed: plan.push.length,
      pulled: pulled.length,
      applied: applied.upserts.length + applied.removed.length,
      server,
    }
    await saveLastSync(info)
    useSync.setState({ last: info })
    return info
  } catch (error) {
    const reason: TranslationKey = error instanceof SyncError ? error.key : 'syncErrorUnknown'
    const info: LastSyncInfo = {
      at,
      ok: false,
      pushed: 0,
      pulled: 0,
      applied: 0,
      server,
      reason,
      message: error instanceof SyncError
        ? error.detail
        : error instanceof Error ? error.message : String(error),
    }
    await saveLastSync(info).catch(() => undefined)
    useSync.setState({ last: info })
    throw error instanceof SyncError ? error : new SyncError('syncErrorUnknown', info.message)
  } finally {
    useSync.setState({ busy: null })
  }
}

