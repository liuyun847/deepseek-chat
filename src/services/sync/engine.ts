import { create } from 'zustand'
import type { TranslationKey } from '../../i18n/index.js'
import { localServiceReady } from '../localService.js'
import * as db from '../chat/db.js'
import { flushChatStorage, reloadChatFromStorage, useChatStore } from '../chat/store.js'
import { saveSyncGroup, useSettings } from '../settings.js'
import {
  fetchGroup,
  fetchHealth,
  fetchState,
  pushRecords,
  resolveServerUrl,
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
import { applyPulledLocalRecords, readLocalSyncExtras } from './local.js'
import { compareRecords, MAX_SYNC_BYTES, recordKey, type SyncRecord } from './protocol.js'
import { loadLastSync, loadSnapshots, saveLastSync, saveSnapshots, type LastSyncInfo } from './snapshots.js'

/** 同步状态：busy 用于禁用按钮，last 用于展示上次结果（页面打开时从记账库读回） */
export type SyncBusy = 'test' | 'sync'

type SyncState = {
  busy: SyncBusy | null
  last: LastSyncInfo | null
}

export const useSync = create<SyncState>(() => ({ busy: null, last: null }))

/**
 * 决定这次同步连哪个服务。
 *
 * 顺序：设置里手填的地址优先；没填且本页由本机服务托管时，用同源反代 /sync/api
 * （local-server 再转到 127.0.0.1:7788），于是浏览器零配置就能拉到手机同步来的数据。
 * APK 与 file:// 页面探测不到本机服务，行为与以前一致：没填地址就提示先配置。
 *
 * @returns 规范化后的服务地址
 * @throws SyncError('syncErrorUrl') 既没手填、也不在同源场景
 * @sideeffect 等待一次 localServiceReady（探测只跑一次，已有结果时立即返回）
 */
const resolveServer = async (): Promise<string> => {
  // 探测是异步的：设置页可能在探测落地之前就点了同步，先等出结果再决定走不走同源
  const localService = await localServiceReady
  const url = resolveServerUrl(useSettings.getState().syncServerUrl, localService)
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

/**
 * 数一遍活记录（墓碑不计入）。
 * 只数会话与消息：设置、提示词、选中项的条数与「首次同步会不会覆盖我的聊天」无关，
 * 混进 messages 会让首次同步的确认框显示一个莫名其妙的大数字。
 */
const countAlive = (records: SyncRecord[]) => {
  let sessions = 0
  let messages = 0
  for (const record of records) {
    if (record.deletedAt != null) {
      continue
    }
    if (record.kind === 'session') {
      sessions += 1
    } else if (record.kind === 'message') {
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
  const server = await resolveServer()
  useSync.setState({ busy: 'test' })
  try {
    return await fetchHealth(server, useSettings.getState().syncGroupToken || undefined)
  } finally {
    useSync.setState({ busy: null })
  }
}

/**
 * 首次同步的确认数据。
 * 只有「本机从没同步过」且「远端已有记录」时才返回内容，其它情况返回 null（直接同步）。
 */
export const prepareFirstSync = async (): Promise<FirstSyncPreview | null> => {
  const server = await resolveServer()
  if (await loadLastSync()) {
    return null
  }
  const remote = countAlive(
    await fetchState(server, useSettings.getState().syncGroupToken || undefined)
  )
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
  const server = await resolveServer()
  const {
    syncDeviceId: device,
    syncGroupId,
    syncGroupToken: token,
    syncGroupEpoch,
  } = useSettings.getState()
  useSync.setState({ busy: 'sync' })
  const at = Date.now()
  try {
    // 界面改的是内存缓存，同步读的是 IndexedDB，先落盘
    await flushChatStorage()
    // 组的主机/epoch 可能已被其它设备改过：同步前先拉一次，避免带着旧 epoch 推送
    let epoch = syncGroupEpoch
    if (syncGroupId) {
      try {
        const info = await fetchGroup(server)
        if (info) {
          saveSyncGroup(info)
          epoch = info.epoch
        }
      } catch {
        // 组信息拉取失败不阻塞同步；真过期时下面按 409 再刷新一次
      }
    }
    const sessions = await db.loadAllSessions()
    const snapshots = await loadSnapshots()
    // 设置 / 提示词 / 选中项存在 localStorage：一并读进记录表（同一个合并计划）
    const built = buildLocalRecords({
      sessions,
      snapshots,
      device,
      now: Date.now(),
      ...readLocalSyncExtras(),
    })

    const remoteRecords = await fetchState(server, token || undefined)
    const remote = new Map(remoteRecords.map((record) => [recordKey(record.kind, record.id), record]))
    const plan = planMerge(built.records, remote)
    if (estimatedBytes(plan.push) > MAX_SYNC_BYTES) {
      throw new SyncError('syncErrorTooLarge')
    }

    // 服务端返回的是「合并后的权威全量」，本地只推自己胜出的那部分
    let result
    try {
      result = await pushRecords(server, device, plan.push, token || undefined, epoch || undefined)
    } catch (error) {
      // epoch 过期：刷新组信息后重试一次
      if (error instanceof SyncError && error.status === 409 && syncGroupId) {
        const info = await fetchGroup(server)
        if (!info) {
          throw error
        }
        saveSyncGroup(info)
        result = await pushRecords(server, device, plan.push, token || undefined, info.epoch)
      } else {
        throw error
      }
    }
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
    // 非会话记录（设置 / 提示词 / 选中项）落到 localStorage，并让两个 store 立刻反映
    applyPulledLocalRecords(pulled)
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

