/**
 * 数据文件：直接读写 sync-server 的那份 JSON，让手机 P2P 同步的数据也能被网页端读到。
 *
 * 文件格式与 sync-server/server.mjs 完全一致：
 *   { format: 'chat-demo-sync', version: 2, updatedAt: <ms>, records: { 'kind:id': record } }
 * 记录校验、合并判定一律用编译产物里的 normalizeRecord / planTransfer / planClientApply，
 * 与手机端、与 7788（sync-server）是同一套 LWW + 墓碑规则，因此三条通道互相之间不会
 * 把对方的删除「复活」，也不会把同一条记录来回改。
 *
 * 并发策略（与 7788 共存的关键）
 * ==========================
 *   1. 写完即弃：本进程不把内存里的表当权威，每次同步都「重读文件 → 合并 → 原子写」，
 *      所以不会用几分钟前的旧视图把别人新写的记录盖掉。
 *   2. 原子写：唯一临时文件 + rename（同盘 rename 是原子的），失败重试几次；
 *      写一半断电不会留下半个 JSON。
 *   3. 覆盖层兜底：本进程把自己参与过的「已知并集」留在内存，定时按 LWW 补回文件里
 *      缺失的版本。7788 常驻内存、每次落盘都会用它自己的视图整份覆盖，于是只有 P2P
 *      才有的记录会被它盖掉 —— 这条定时修补把它们找回来。墓碑时间更新，因此不会复活删除。
 *   4. 文件损坏（JSON 解析不了 / format 不对）时拒绝写入：宁可不同步，也不覆盖用户数据。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { normalizeRecord, recordKey, SYNC_FORMAT, SYNC_VERSION } from './build/src/services/sync/protocol.js'
import { planClientApply, planTransfer } from './build/src/services/sync/lan/transfer.js'

/** rename 的重试次数：Windows 上目标文件被别人短暂打开会拿到 EPERM/EBUSY */
const RENAME_ATTEMPTS = 6

/** 存储层的可预期错误 */
export class StoreError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'StoreError'
    this.code = code
  }
}

/** 等一会儿（重试退避） */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 原子写：先写唯一临时文件，再 rename 到目标。
 *
 * @param {string} file 目标文件
 * @param {string} payload 完整内容
 * @param {object} log logger（重试时记一条，能看出「两个进程在抢同一个文件」）
 * @throws {StoreError} code 为 write（重试后仍失败）
 */
const writeAtomic = async (file, payload, log) => {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.lan-' + process.pid + '-' + Date.now().toString(36) + '.tmp'
  await fsp.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  let lastError = null
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (error) {
      lastError = error
      if (error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'EACCES') {
        break
      }
      log?.warn('数据文件被占用（' + error.code + '），rename 重试 ' + attempt + '/' + RENAME_ATTEMPTS)
      await sleep(40 * attempt)
    }
  }
  try {
    await fsp.unlink(tmp)
  } catch (error) {
    // 临时文件删不掉不影响结论
  }
  throw new StoreError('write', '写入 ' + file + ' 失败：' + (lastError?.message || 'unknown'))
}

/**
 * 读数据文件。
 *
 * @param {string} file 数据文件路径
 * @returns {Promise<{ records: Map<string, object>, missing?: boolean, corrupt?: string,
 *   invalid: number }>} missing = 文件还不存在（空库）；corrupt = 文件在但读不懂（禁止写入）
 */
const readFileRecords = async (file) => {
  let text = null
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { records: new Map(), missing: true, invalid: 0 }
    }
    return { records: new Map(), corrupt: '读不了文件：' + error.message, invalid: 0 }
  }
  if (text.trim() === '') {
    // 空文件（例如编辑器刚建出来）当作空库，可以写
    return { records: new Map(), invalid: 0 }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { records: new Map(), corrupt: 'JSON 解析失败：' + error.message, invalid: 0 }
  }
  if (!parsed || typeof parsed !== 'object' || parsed.format !== SYNC_FORMAT) {
    return {
      records: new Map(),
      corrupt: 'format 不是 ' + SYNC_FORMAT + '（实际 ' + String(parsed?.format) + '），不是本项目的同步数据文件',
      invalid: 0,
    }
  }
  const records = new Map()
  let invalid = 0
  const source = parsed.records && typeof parsed.records === 'object' ? parsed.records : {}
  for (const value of Object.values(source)) {
    const record = normalizeRecord(value)
    if (!record) {
      invalid += 1
      continue
    }
    // 键一律按 kind:id 重算：文件里的键即使被改错，也不会让同一条记录变成两条
    records.set(recordKey(record.kind, record.id), record)
  }
  return { records, invalid }
}

/**
 * 造一个存储对象。
 *
 * @param {{ file: string, log: object }} options
 * @returns {object} 见下面各方法的注释
 * @sideeffect 写文件；在内存里保留「已知并集」覆盖层
 */
export const createStore = (options) => {
  const file = options.file
  const log = options.log
  /** 本进程见过的权威版本（key → record），用于补回被别的进程整份覆盖掉的记录 */
  const known = new Map()
  /** 最近一次自己写文件的时间：文件监听据此区分「自己写的」与「别人写的」 */
  let lastWriteAt = 0
  /** 串行化写入：同一时刻只有一次「读-合并-写」在进行 */
  let chain = Promise.resolve()

  const serialize = (task) => {
    const next = chain.then(task, task)
    chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /** 记住一批记录（覆盖层） */
  const remember = (records) => {
    for (const [key, record] of records) {
      known.set(key, record)
    }
  }

  /**
   * 写一批记录（整份覆盖文件）。
   *
   * @param {Map<string, object>} records 合并后的全量
   * @sideeffect 落盘 + 更新覆盖层 + 记 lastWriteAt
   */
  const persist = async (records) => {
    const sorted = [...records.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))
    const payload = JSON.stringify({
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      updatedAt: Date.now(),
      records: Object.fromEntries(sorted),
    })
    await writeAtomic(file, payload, log)
    lastWriteAt = Date.now()
    remember(records)
  }

  return {
    file,

    /** 最近一次自己写文件的时间（毫秒），供文件监听区分自己/别人 */
    lastWriteAt: () => lastWriteAt,

    /**
     * 读当前文件里的全量记录。
     * @returns {Promise<{ records: Map<string, object>, corrupt?: string, missing?: boolean }>}
     */
    read: () => readFileRecords(file),

    /**
     * 应答方：合并对端发来的记录，返回要回给对端的差异。
     *
     * @param {object[]} incoming 对端发来的记录（已由 parseMessage 规范化）
     * @returns {Promise<{ reply: object[], applied: number, received: number, total: number }>}
     * @throws {StoreError} code 为 corrupt（文件读不懂，拒绝写入）或 write
     */
    serve: (incoming) =>
      serialize(async () => {
        const state = await readFileRecords(file)
        if (state.corrupt) {
          throw new StoreError('corrupt', state.corrupt)
        }
        const plan = planTransfer(state.records, incoming)
        await persist(plan.merged)
        return {
          reply: plan.reply,
          applied: plan.apply.length,
          received: plan.received,
          total: plan.merged.size,
          changed: plan.apply.length > 0 || plan.reply.length > 0,
        }
      }),

    /**
     * 请求方：把对端回的差异落到本地文件。
     *
     * @param {object[]} reply 对端回的记录
     * @returns {Promise<{ pulled: number, total: number, changed: boolean }>}
     * @throws {StoreError} 同上
     */
    applyReply: (reply) =>
      serialize(async () => {
        const state = await readFileRecords(file)
        if (state.corrupt) {
          throw new StoreError('corrupt', state.corrupt)
        }
        const plan = planClientApply(state.records, reply)
        const changed = plan.pulled.length > 0
        if (changed) {
          await persist(plan.merged)
        } else {
          remember(plan.merged)
        }
        return { pulled: plan.pulled.length, total: plan.merged.size, changed }
      }),

    /**
     * 定时修补：把「本进程见过的版本」按 LWW 补回文件里缺失的部分。
     *
     * 只补不删：合并规则仍是 LWW + 墓碑，因此别人删掉的记录（墓碑时间更新）不会被复活。
     *
     * @returns {Promise<{ restored: number, skipped?: string }>} restored = 补回的记录条数
     */
    repair: () =>
      serialize(async () => {
        if (known.size === 0) {
          return { restored: 0 }
        }
        const state = await readFileRecords(file)
        if (state.corrupt) {
          return { restored: 0, skipped: state.corrupt }
        }
        const plan = planTransfer(state.records, [...known.values()])
        if (plan.apply.length === 0) {
          remember(plan.merged)
          return { restored: 0 }
        }
        await persist(plan.merged)
        return { restored: plan.apply.length }
      }),

    /**
     * 文件规模统计（写日志用，不含正文）。
     * @returns {Promise<{ records: number, sessions: number, messages: number, tombstones: number,
     *   corrupt?: string }>}
     */
    stats: async () => {
      const state = await readFileRecords(file)
      let sessions = 0
      let messages = 0
      let tombstones = 0
      for (const record of state.records.values()) {
        if (record.deletedAt != null) {
          tombstones += 1
        }
        if (record.kind === 'session' && record.deletedAt == null) {
          sessions += 1
        }
        if (record.kind === 'message' && record.deletedAt == null) {
          messages += 1
        }
      }
      const result = { records: state.records.size, sessions, messages, tombstones }
      if (state.corrupt) {
        result.corrupt = state.corrupt
      }
      if (state.invalid > 0) {
        result.invalid = state.invalid
      }
      return result
    },
  }
}
