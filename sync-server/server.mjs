#!/usr/bin/env node
/**
 * 多端同步服务（M1）。零依赖：只用 node: 内置模块。
 *
 * 用法
 *   node sync-server/server.mjs [--port 7788] [--host 127.0.0.1] [--data <json 文件>] [--name <名称>]
 *   node sync-server/server.mjs --help
 *
 * 环境变量（命令行参数优先）
 *   SYNC_PORT / SYNC_HOST / SYNC_DATA / SYNC_NAME
 *
 * 定位
 *   数据的集散地，不参与业务：按记录（会话、消息）保存，收到推送后按同样的
 *   LWW + 墓碑规则合并，再把合并后的全量回给客户端。客户端与服务端必须是同一套规则，
 *   因此本文件的 compareRecords / collapseDeletedSessions 与 src/services/sync/merge.ts 逐条对应；
 *   改一侧必须同步改另一侧（双端验证会同时覆盖两边）。
 *
 * 端点
 *   GET  /api/health   探活 + 统计（客户端的「测试连接」）
 *   GET  /api/state    全量记录（含墓碑）
 *   POST /api/sync     推送变更 { device, records } → 合并后返回全量
 *
 * 存储
 *   一个 JSON 文件，原子写（先写 .tmp 再 rename），写入去抖 200ms，退出前强制落盘。
 *   文件结构：{ format, version, updatedAt, records: { "kind:id": record } }
 */

import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与客户端一致的协议标识与版本；不匹配直接拒绝，避免两套语义互相污染 */
const SYNC_FORMAT = 'chat-demo-sync'
const SYNC_VERSION = 1
/** 单次请求体上限（32 MB），与客户端 MAX_SYNC_BYTES 一致 */
const MAX_BODY = 32 * 1024 * 1024
/** 落盘去抖 */
const FLUSH_DELAY = 200

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── 参数 ────────────────────────────────────────────────────────────────────

/** 解析 --key value / --flag 形式的参数 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(
    [
      '用法: node sync-server/server.mjs [--port 7788] [--host 127.0.0.1] [--data <文件>] [--name <名称>]',
      '',
      '  --port   监听端口，默认 7788（也可用 SYNC_PORT）',
      '  --host   监听地址，默认 127.0.0.1；局域网内其它设备要连时用 0.0.0.0（也可用 SYNC_HOST）',
      '  --data   数据文件，默认 sync-server/data/sync-data.json（也可用 SYNC_DATA）',
      '  --name   在 /api/health 里自报的名字，默认取主机名（也可用 SYNC_NAME）',
    ].join('\n')
  )
  process.exit(0)
}

const PORT = Number(args.port ?? process.env.SYNC_PORT ?? 7788)
const HOST = String(args.host ?? process.env.SYNC_HOST ?? '127.0.0.1')
const DATA = path.resolve(
  String(args.data ?? process.env.SYNC_DATA ?? path.join(HERE, 'data', 'sync-data.json'))
)
const NAME = String(args.name ?? process.env.SYNC_NAME ?? (os.hostname() || 'sync-server').split('.')[0])

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error('[sync] 端口无效:', PORT)
  process.exit(1)
}
// ── 记录与合并规则（与 src/services/sync/merge.ts 对应） ────────────────────

/** 记录主键 */
const recordKey = (kind, id) => kind + ':' + id

/** 记录版本比较：updatedAt 大者胜；相等时 device 字典序大者胜（两端结果一致，不会永久分叉） */
function compareRecords(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? 1 : -1
  if (a.device === b.device) return 0
  return a.device > b.device ? 1 : -1
}

/**
 * 会话已删除时，其消息记录一律墓碑化。
 * 墓碑字段只由会话墓碑推导（不看消息自己的时间戳），因此各端算出完全相同的记录，
 * 不会出现「A 端墓碑、B 端活记录」互相推翻的来回同步。
 */
function collapseDeletedSessions(records) {
  let collapsed = 0
  for (const session of records.values()) {
    if (session.kind !== 'session' || session.deletedAt == null) continue
    for (const record of records.values()) {
      if (record.kind !== 'message' || record.sessionId !== session.id) continue
      if (record.deletedAt != null) continue
      record.updatedAt = session.updatedAt
      record.device = session.device
      record.deletedAt = session.deletedAt
      record.data = null
      collapsed += 1
    }
  }
  return collapsed
}

/**
 * 校验并规范化一条外部传入的记录。
 * @param value 请求体里的一条记录
 * @returns 规范化后的记录；不合法返回 null（由调用方整体拒绝，不留半个事务）
 */
function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { kind, id, sessionId, updatedAt, device, deletedAt, data } = value
  if (kind !== 'session' && kind !== 'message') return null
  if (typeof id !== 'string' || !id) return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return null
  if (typeof device !== 'string' || !device) return null
  if (deletedAt !== undefined && deletedAt !== null) {
    if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt)) return null
  }
  const tombstone = deletedAt !== undefined && deletedAt !== null
  if (!tombstone && (!data || typeof data !== 'object' || Array.isArray(data))) return null
  if (kind === 'message' && typeof sessionId !== 'string') return null
  if (kind === 'message' && !tombstone && data.role !== 'user' && data.role !== 'assistant') {
    return null
  }
  if (kind === 'session' && !tombstone && typeof data.id !== 'string') return null
  const record = { kind, id, updatedAt, device, data: tombstone ? null : data }
  if (kind === 'message') record.sessionId = sessionId
  if (tombstone) record.deletedAt = deletedAt
  return record
}

// ── 存储 ────────────────────────────────────────────────────────────────────

/** key → record。启动后常驻内存，落盘只是快照。 */
let store = new Map()
let dirty = false
let flushTimer = null
let writeChain = Promise.resolve()

/** 原子落盘：写临时文件再 rename，进程被 kill 也不会留半个 JSON */
function flush() {
  dirty = false
  const payload = JSON.stringify({
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    updatedAt: Date.now(),
    records: Object.fromEntries(
      [...store.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    ),
  })
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(path.dirname(DATA), { recursive: true })
      const tmp = DATA + '.tmp'
      await fsp.writeFile(tmp, payload, 'utf8')
      await fsp.rename(tmp, DATA)
    })
    .catch((error) => {
      console.error('[sync] 落盘失败:', error.message)
    })
  return writeChain
}

function markDirty() {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (dirty) void flush()
  }, FLUSH_DELAY)
}

async function load() {
  try {
    const parsed = JSON.parse(await fsp.readFile(DATA, 'utf8'))
    if (parsed?.format !== SYNC_FORMAT) {
      console.warn('[sync] 数据文件不是本服务的格式，按空库启动:', DATA)
      return
    }
    for (const [key, value] of Object.entries(parsed.records ?? {})) {
      const record = normalizeRecord(value)
      if (record) store.set(key, record)
    }
    console.log('[sync] 已载入 %d 条记录：%s', store.size, DATA)
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[sync] 新建数据文件：%s', DATA)
    } else {
      console.warn('[sync] 读不到存档（%s），按空库启动：%s', error.message, DATA)
    }
  }
}

/** 全量记录（按 key 排序，客户端与日志都好读） */
const allRecords = () =>
  [...store.values()].sort((a, b) =>
    recordKey(a.kind, a.id) < recordKey(b.kind, b.id) ? -1 : 1
  )

/** /api/health 的统计：活记录与墓碑分开数 */
function stats() {
  let sessions = 0
  let messages = 0
  let tombstones = 0
  for (const record of store.values()) {
    if (record.deletedAt != null) tombstones += 1
    if (record.kind === 'session' && record.deletedAt == null) sessions += 1
    if (record.kind === 'message' && record.deletedAt == null) messages += 1
  }
  return { records: store.size, sessions, messages, tombstones }
}
// ── HTTP ────────────────────────────────────────────────────────────────────

/** 客户端可能来自 dev server(8090)、file:// 或别的端口，回显 Origin 最省事 */
function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

function send(req, res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 读请求体；超过上限直接断开，避免无界内存 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 推送：逐条按 LWW 合并，返回采纳 / 拒绝条数 */
function applyPush(incoming) {
  const applied = { accepted: 0, rejected: 0 }
  for (const record of incoming) {
    const key = recordKey(record.kind, record.id)
    const existing = store.get(key)
    if (!existing) {
      store.set(key, record)
      applied.accepted += 1
      continue
    }
    if (compareRecords(record, existing) > 0) {
      store.set(key, record)
      applied.accepted += 1
    } else {
      applied.rejected += 1
    }
  }
  return applied
}

/** 日志时间戳（只取时分秒毫秒，便于和浏览器操作对齐） */
const stamp = () => new Date().toISOString().slice(11, 23)

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'))
  const log = (status, extra) => {
    console.log(
      '[sync] %s %s %s %d %dms%s',
      stamp(),
      req.method,
      url.pathname,
      status,
      Date.now() - started,
      extra ? ' ' + extra : ''
    )
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req))
    res.end()
    log(204)
    return
  }

  if (url.pathname === '/' && req.method === 'GET') {
    send(req, res, 200, {
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      name: NAME,
      endpoints: ['GET /api/health', 'GET /api/state', 'POST /api/sync'],
    })
    log(200)
    return
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    send(req, res, 200, {
      ok: true,
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      name: NAME,
      time: Date.now(),
      dataFile: DATA,
      ...stats(),
    })
    log(200)
    return
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    send(req, res, 200, {
      ok: true,
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      time: Date.now(),
      records: allRecords(),
    })
    log(200, 'records=' + store.size)
    return
  }

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    let payload
    try {
      payload = JSON.parse(await readBody(req))
    } catch (error) {
      send(req, res, error.status === 413 ? 413 : 400, { ok: false, error: error.message })
      log(error.status ?? 400, 'bad-body')
      return
    }
    if (payload?.format !== undefined && payload.format !== SYNC_FORMAT) {
      send(req, res, 400, { ok: false, error: '同步协议不匹配' })
      log(400, 'format')
      return
    }
    if (!Array.isArray(payload?.records)) {
      send(req, res, 400, { ok: false, error: 'records 必须是数组' })
      log(400, 'no-records')
      return
    }
    const incoming = []
    for (let i = 0; i < payload.records.length; i += 1) {
      const record = normalizeRecord(payload.records[i])
      if (!record) {
        send(req, res, 400, { ok: false, error: 'records[' + i + '] 不是合法记录' })
        log(400, 'bad-record')
        return
      }
      incoming.push(record)
    }
    const applied = applyPush(incoming)
    const collapsed = collapseDeletedSessions(store)
    if (applied.accepted > 0 || collapsed > 0) markDirty()
    send(req, res, 200, {
      ok: true,
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      time: Date.now(),
      applied,
      collapsed,
      records: allRecords(),
    })
    log(
      200,
      'device=' + String(payload.device ?? '?') +
        ' +' + applied.accepted +
        ' -' + applied.rejected +
        ' records=' + store.size
    )
    return
  }

  send(req, res, 404, { ok: false, error: '未知端点: ' + req.method + ' ' + url.pathname })
  log(404)
})

// ── 生命周期 ────────────────────────────────────────────────────────────────

let closing = false

/** 关掉监听并落盘；SIGINT 是 Windows 上 Ctrl+C 的常态 */
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log('\n[sync] 收到 %s，正在落盘并退出…', signal)
  clearTimeout(flushTimer)
  server.close()
  await flush()
  console.log('[sync] 已退出')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGHUP', () => void shutdown('SIGHUP'))

await load()
server.listen(PORT, HOST, () => {
  console.log('[sync] %s v%d 监听 http://%s:%d', SYNC_FORMAT, SYNC_VERSION, HOST, PORT)
  console.log('[sync] 数据文件 %s', DATA)
  console.log('[sync] 名称 %s', NAME)
})
