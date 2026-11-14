import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { TranslationKey } from '../../i18n/index.js'
import type { RecordSnapshot } from './protocol.js'

/**
 * 同步记账库：与聊天数据分库（chat-demo-sync），
 * 因此不需要动 chat-demo 的库版本，也不会和「导入历史」的暂存事务相互影响。
 */
const DB_NAME = 'chat-demo-sync'
const DB_VERSION = 1

/** 上次同步的结果：跨刷新保留，设置页直接展示 */
export type LastSyncInfo = {
  /** 同步发生的时刻 */
  at: number
  ok: boolean
  /** 本次推给服务端的记录数 */
  pushed: number
  /** 本次从服务端拉回并落地的记录数 */
  pulled: number
  /** 落地后发生写入或删除的会话数 */
  applied: number
  /** 服务地址 */
  server: string
  /** 失败时的文案 key */
  reason?: TranslationKey
  /** 失败时的附加信息（错误详情、服务端原文） */
  message?: string
}

type MetaEntry<T> = { key: string; value: T }

interface SyncDB extends DBSchema {
  records: { key: string; value: RecordSnapshot }
  meta: { key: string; value: MetaEntry<LastSyncInfo> }
}

const LAST_SYNC_KEY = 'lastSync'

let dbPromise: Promise<IDBPDatabase<SyncDB>> | null = null

/** 建表；新库与「库已存在但缺表」两种情况共用 */
const upgrade = (db: IDBPDatabase<SyncDB>) => {
  if (!db.objectStoreNames.contains('records')) {
    db.createObjectStore('records', { keyPath: 'key' })
  }
  if (!db.objectStoreNames.contains('meta')) {
    db.createObjectStore('meta', { keyPath: 'key' })
  }
}

const hasStores = (db: IDBPDatabase<SyncDB>) =>
  db.objectStoreNames.contains('records') && db.objectStoreNames.contains('meta')

/**
 * 打开记账库。
 * 正常情况直接按 DB_VERSION 打开并由 upgrade 建表；若同名库已被别的调用方按最新版本建成空库
 * （upgrade 不会再触发），升一版强制建表，别让同步因为「少一张表」直接崩掉。
 */
const openSyncDB = async (): Promise<IDBPDatabase<SyncDB>> => {
  const db = await openDB<SyncDB>(DB_NAME, DB_VERSION, { upgrade })
  if (hasStores(db)) {
    return db
  }
  const version = db.version + 1
  db.close()
  return openDB<SyncDB>(DB_NAME, version, { upgrade })
}

const getDB = () =>
  (dbPromise ??= openSyncDB().catch((error: unknown) => {
    dbPromise = null
    throw error
  }))

/** 读出全部记账（key 为 kind:id） */
export const loadSnapshots = async (): Promise<Map<string, RecordSnapshot>> => {
  const entries = await (await getDB()).getAll('records')
  return new Map(entries.map((entry) => [entry.key, entry]))
}

/**
 * 用本次同步的结果整体替换记账。
 * 整体替换而不是逐条 upsert：记账必须与「本轮合并后的记录」严格一致，
 * 少一条会让对应记录下次被当成「本地新增」重新推送。
 */
export const saveSnapshots = async (snapshots: Iterable<RecordSnapshot>): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction('records', 'readwrite')
  await Promise.all([
    (async () => {
      await tx.store.clear()
      for (const snapshot of snapshots) {
        await tx.store.put(snapshot)
      }
    })(),
    tx.done,
  ])
}

/** 读上次同步结果；从没同步过返回 null */
export const loadLastSync = async (): Promise<LastSyncInfo | null> =>
  (await (await getDB()).get('meta', LAST_SYNC_KEY))?.value ?? null

export const saveLastSync = async (info: LastSyncInfo): Promise<void> => {
  await (await getDB()).put('meta', { key: LAST_SYNC_KEY, value: info })
}

