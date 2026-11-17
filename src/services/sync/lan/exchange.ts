import * as db from '../../chat/db.js'
import type { Session } from '../../chat/types.js'
import { useChatStore, flushChatStorage, reloadChatFromStorage } from '../../chat/store.js'
import { applyPulledLocalRecords, readLocalSyncExtras } from '../local.js'
import { applyPulledRecords, buildLocalRecords, recordsToSnapshots } from '../merge.js'
import type { SyncRecord } from '../protocol.js'
import { loadSnapshots, saveSnapshots } from '../snapshots.js'
import { planClientApply, planTransfer } from './transfer.js'

/**
 * 把「合并计划」接到本机 IndexedDB 上。
 *
 * 与 HTTP 通道（engine.ts）的关系
 * ============================
 * 合并规则、记账、落地全部复用同一批函数（buildLocalRecords / planTransfer /
 * planClientApply / applyPulledRecords / recordsToSnapshots），这里只是把 engine.ts 里
 * 「拉全量 → 合并 → 推送 → 落地」那段胶水换成「点对点的一问一答」。engine.ts 一行没改，
 * HTTP 通道照旧可用。
 */

/** 本机全量记录 + 会话（一次同步内保持一致快照） */
export type LocalState = { sessions: Session[]; records: Map<string, SyncRecord> }

/**
 * 读本地全量记录。
 *
 * 界面改的是内存缓存、同步读的是 IndexedDB，所以先 flush（与 HTTP 通道同一前提）。
 *
 * @param device 本机设备 id（写入新记录的 device 字段）
 * @returns 会话列表与记录表
 */
export const readLocalState = async (device: string): Promise<LocalState> => {
  await flushChatStorage()
  const sessions = await db.loadAllSessions()
  const snapshots = await loadSnapshots()
  // 设置 / 提示词 / 选中项存在 localStorage：与 HTTP 通道读的是同一份（见 local.ts）
  const built = buildLocalRecords({
    sessions,
    snapshots,
    device,
    now: Date.now(),
    ...readLocalSyncExtras(),
  })
  return { sessions, records: built.records }
}

/** 落地结果：写回/删除的会话数与拉到本地的记录数 */
export type CommitResult = { applied: number; pulled: number }

/**
 * 把一批（合并后的）记录落到本地会话表，并整体重写记账。
 *
 * @param state 读出来的本地快照（会话与记录）
 * @param pulled 需要落地到本地的记录（本地缺失或对端更新）
 * @param merged 合并后的权威全量表（记账必须与它严格一致）
 * @returns 实际写入/删除的会话数与被落地的记录数
 * @sideeffect 写 IndexedDB、重写 chat-demo-sync 的 records 表；有变化时重载内存缓存
 */
const commit = async (
  state: LocalState,
  pulled: SyncRecord[],
  merged: Map<string, SyncRecord>
): Promise<CommitResult> => {
  const applied = applyPulledRecords(state.sessions, pulled)
  for (const session of applied.upserts) {
    await db.saveSession(session)
  }
  for (const id of applied.removed) {
    await db.deleteSession(id)
  }
  // 非会话记录（设置 / 提示词 / 选中项）落到 localStorage，并让两个 store 立刻反映
  const extras = applyPulledLocalRecords(pulled)
  await saveSnapshots(recordsToSnapshots(merged.values()))
  if (applied.upserts.length > 0 || applied.removed.length > 0) {
    await reloadChatFromStorage()
  }
  return {
    applied: applied.upserts.length + applied.removed.length + extras,
    pulled: pulled.length,
  }
}

/** 应答方：合并对方发来的记录，返回要回给对方的差异 */
export type ServeResult = { reply: SyncRecord[]; applied: number; received: number }

/**
 * 处理对方发来的一批记录。
 *
 * @param device 本机设备 id
 * @param incoming 对方发来的记录（已通过 normalizeRecord 校验）
 * @returns 对方需要落地的差异 + 本地落地条数 + 收到条数
 * @sideeffect 对方赢的记录写进本机会话表，记账整体重写
 */
export const serveIncoming = async (device: string, incoming: SyncRecord[]): Promise<ServeResult> => {
  const state = await readLocalState(device)
  const plan = planTransfer(state.records, incoming)
  const result = await commit(state, plan.apply, plan.merged)
  return { reply: plan.reply, applied: result.applied, received: plan.received }
}

/** 请求方：把对方回的差异落地 */
export type ClientResult = { applied: number; pulled: number }

/**
 * 把对方回给我的差异落到本地。
 *
 * @param state 发起前读到的本地快照（必须与发出去的记录同源，否则判定会错）
 * @param reply 对方回的差异记录
 * @returns 落地条数与会话改动数
 */
export const commitReply = async (state: LocalState, reply: SyncRecord[]): Promise<ClientResult> => {
  const plan = planClientApply(state.records, reply)
  const result = await commit(state, plan.pulled, plan.merged)
  return { applied: result.applied, pulled: plan.pulled.length }
}

/**
 * 当前是否允许开始一次同步：有回复在生成、或正在导入历史时不做，
 * 否则会与这两条流程抢同一份 IndexedDB（与 HTTP 通道 engine.ts 的判据一致）。
 *
 * @returns 不能同步时的原因 key；可以同步返回 null
 */
export const syncBlockedReason = (): 'streaming' | 'importing' | null => {
  const chat = useChatStore.getState()
  if (chat.importingHistory) {
    return 'importing'
  }
  if (Object.keys(chat.streaming).length > 0) {
    return 'streaming'
  }
  return null
}
