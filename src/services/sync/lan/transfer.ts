import { collapseDeletedSessions } from '../merge.js'
import { compareRecords, recordKey, type SyncRecord } from '../protocol.js'

/**
 * 两台设备之间「只传差异」的合并计划。
 *
 * 为什么不是照搬 HTTP 那条链路
 * =========================
 * HTTP 通道里服务端是权威副本：客户端推上去一批，服务端回「合并后的全量」，客户端再
 * 自己算一遍要落地哪些。手机上点对点没有第三方：请求方把本地记录发过去，应答方合并后
 * 只回「请求方缺的 / 应答方赢的」那些 —— 一来省一半流量（不用回全量），二来两端都在
 * 本地完成同一套 LWW 判定（compareRecords），结论必然一致。
 *
 * 合并规则本身一行没改：逐条按 compareRecords（updatedAt 大者胜、同毫秒 device 字典序
 * 大者胜）判胜负，会话删除由 collapseDeletedSessions 把名下消息一并墓碑化 —— 与
 * merge.ts / sync-server 完全同一套语义，因此三条通道（HTTP、点对点、离线导入）互相之间
 * 不会把对方的删除「复活」。
 */

export type TransferResult = {
  /** 要回给对方的记录：对方缺失，或本地这一版更新，或本地是墓碑而对方还是活记录 */
  reply: SyncRecord[]
  /** 要落到本地的记录：本地缺失，或对方更新，或对方是墓碑而本地还是活记录 */
  apply: SyncRecord[]
  /** 合并后的全量记录表（已折叠会话删除），用于写回记账 */
  merged: Map<string, SyncRecord>
  /** 两端版本完全一致、什么也不用做的条数 */
  even: number
  /** 本次收到的记录条数（含被丢弃前的数量由调用方统计） */
  received: number
}

/**
 * 应答方视角：本地记录 + 对方发来的记录 → 回给对方什么、本地落地什么。
 *
 * @param local 本地全量记录（buildLocalRecords 的结果，key 为 kind:id）
 * @param incoming 对方发来的记录
 * @returns 差异计划；merged 是合并后的权威表（用于 saveSnapshots）
 * @sideeffect 只改本函数内部的副本，不改 local / incoming 里的对象
 */
export const planTransfer = (
  local: Map<string, SyncRecord>,
  incoming: SyncRecord[]
): TransferResult => {
  const incomingMap = new Map<string, SyncRecord>()
  for (const record of incoming) {
    incomingMap.set(recordKey(record.kind, record.id), record)
  }

  // 一律先复制再合并：collapseDeletedSessions 会原地改记录，若与 local 共享对象，
  // 会把「本地原本是活记录」这个事实一起改掉，下面判断「要不要落地」就永远为假。
  const merged = new Map<string, SyncRecord>()
  for (const [key, record] of local) {
    merged.set(key, { ...record })
  }
  for (const [key, record] of incomingMap) {
    const mine = merged.get(key)
    if (!mine || compareRecords(record, mine) > 0) {
      merged.set(key, { ...record })
    }
  }

  // 会话删除优先于其名下消息的独立变更（与 merge.ts / server.mjs 同一条规则）
  collapseDeletedSessions(merged)

  const reply: SyncRecord[] = []
  const apply: SyncRecord[] = []
  let even = 0
  for (const [key, record] of merged) {
    const theirs = incomingMap.get(key)
    const mine = local.get(key)
    const toTheirs =
      !theirs ||
      compareRecords(record, theirs) > 0 ||
      // 墓碑的时间戳可能比对方的活记录更旧（派生自会话墓碑），仍要压过去
      (record.deletedAt != null && theirs.deletedAt == null)
    const toLocal =
      !mine ||
      compareRecords(record, mine) > 0 ||
      (record.deletedAt != null && mine.deletedAt == null)
    if (toTheirs) {
      reply.push(record)
    }
    if (toLocal) {
      apply.push(record)
    }
    if (!toTheirs && !toLocal) {
      even += 1
    }
  }
  return { reply, apply, merged, even, received: incoming.length }
}

export type ClientApplyResult = {
  /** 要落到本地的记录（对方赢或本地缺失） */
  pulled: SyncRecord[]
  /** 落地后的权威全量表（用于写回记账） */
  merged: Map<string, SyncRecord>
}

/**
 * 请求方视角：本地记录 + 对方回给我的差异 → 本地落地什么。
 * 与 HTTP 通道 engine.ts 里「finalRecords → pulled」那段是同一套判定，只是输入从
 * 「服务端全量」换成「对方给的差异」，因此不需要再拉一次全量。
 *
 * @param local 本地全量记录
 * @param reply 对方回的差异记录
 * @returns 要落地的记录与合并后的权威表
 * @sideeffect 只改副本，不改入参里的对象
 */
export const planClientApply = (
  local: Map<string, SyncRecord>,
  reply: SyncRecord[]
): ClientApplyResult => {
  const merged = new Map<string, SyncRecord>()
  for (const [key, record] of local) {
    merged.set(key, { ...record })
  }
  for (const record of reply) {
    merged.set(recordKey(record.kind, record.id), { ...record })
  }
  collapseDeletedSessions(merged)

  const pulled: SyncRecord[] = []
  for (const [key, record] of merged) {
    const mine = local.get(key)
    if (
      !mine ||
      compareRecords(record, mine) > 0 ||
      (record.deletedAt != null && mine.deletedAt == null)
    ) {
      pulled.push(record)
    }
  }
  return { pulled, merged }
}
