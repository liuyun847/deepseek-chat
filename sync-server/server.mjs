#!/usr/bin/env node
/**
 * 多端同步服务（M1）。零依赖：只用 node: 内置模块。
 *
 * 用法
 *   node sync-server/server.mjs [--port 7788] [--host 127.0.0.1] [--data <json 文件>] [--name <名称>]
 *   node sync-server/server.mjs --token <口令> [--allow-origin <来源>]
 *   node sync-server/server.mjs --help
 *
 * 环境变量（命令行参数优先）
 *   SYNC_PORT / SYNC_HOST / SYNC_DATA / SYNC_NAME / SYNC_TOKEN / SYNC_ALLOWED_ORIGINS
 *
 * 来源与口令（发布前安全审计 BLOCKER-2）
 *   - CORS 只放行三类来源：①回环 host（127.0.0.1 / localhost / [::1]，http，端口不限；
 *     网页伪造不出这种来源）、②与请求 Host 严格同源、③--allow-origin / SYNC_ALLOWED_ORIGINS
 *     追加的来源与 Android 外壳的 https://dsapp.local；其余（含 Origin: null）不回任何 CORS 头
 *     并直接 403，预检与真实请求走同一道闸。无 Origin 的请求（curl、同源导航）不拦也不放宽。
 *   - 设了 SYNC_TOKEN / --token 之后，所有 /api/* 必须带 Authorization: Bearer <口令>
 *     或 X-Sync-Token 头，否则 401；未设口令时行为与本机自用版本一致，但启动会打印醒目提示。
 *   - 不对外泄漏主机名与数据文件绝对路径：/api/health 只回协议身份、时间、是否设了口令与计数。
 *
 * 定位
 *   数据的集散地，不参与业务：按记录保存（会话、消息、整份设置、提示词、当前选中的提示词），
 *   收到推送后按同样的 LWW + 墓碑规则合并，再把合并后的全量回给客户端。
 *   客户端与服务端必须是同一套规则，因此本文件的 compareRecords / collapseDeletedSessions /
 *   normalizeRecord 与 src/services/sync/{protocol,merge}.ts 逐条对应；
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
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与客户端一致的协议标识与版本；不匹配直接拒绝，避免两套语义互相污染 */
const SYNC_FORMAT = 'chat-demo-sync'
/**
 * v1 → v2：新增 settings / prompt / prompt-selection 三种记录。
 * 只升级一侧时的表现（都是预期，不是数据损坏）：
 *  - 旧客户端（v1）× 本服务（v2）：客户端看到 version 比自己的大，直接拒绝同步，什么也不写
 *  - 新客户端（v2）× 旧服务（v1）：旧服务不认新 kind，整批推送被判非法并回 400
 */
const SYNC_VERSION = 2
/** 单次请求体上限（32 MB），与客户端 MAX_SYNC_BYTES 一致 */
const MAX_BODY = 32 * 1024 * 1024
/** 落盘去抖 */
const FLUSH_DELAY = 200

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── 参数 ────────────────────────────────────────────────────────────────────

/**
 * 解析 --key value / --flag 形式的参数。
 * 同一个键给多次时收成数组（--allow-origin 需要可重复），只给一次时仍是字符串。
 * @param argv process.argv.slice(2)
 * @returns 键值对象；纯开关类参数值为 true
 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : next
    if (value !== true) i += 1
    const prev = out[key]
    if (prev === undefined) out[key] = value
    else if (Array.isArray(prev)) prev.push(value)
    else out[key] = [prev, value]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(
    [
      '用法: node sync-server/server.mjs [--port 7788] [--host 127.0.0.1] [--data <文件>] [--name <名称>] [--token <口令>]',
      '',
      '  --port   监听端口，默认 7788（也可用 SYNC_PORT）',
      '  --host   监听地址，默认 127.0.0.1；局域网内其它设备要连时用 0.0.0.0（也可用 SYNC_HOST）',
      '  --data   数据文件，默认 sync-server/data/sync-data.json（也可用 SYNC_DATA）',
      '  --name   本机日志里显示的名字，默认取主机名；不再对外返回（也可用 SYNC_NAME）',
      '  --token  访问口令；设了之后所有 /api/* 都要带 Authorization: Bearer <口令>',
      '           或 X-Sync-Token 头，否则 401（也可用 SYNC_TOKEN）',
      '  --allow-origin  额外放行的跨域来源，逗号分隔可写多个，可重复给（也可用 SYNC_ALLOWED_ORIGINS）',
      '  --no-webview-origin  不放行 Android 外壳的 https://dsapp.local 来源',
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

// ── 访问口令与跨域来源白名单 ────────────────────────────────────────────────

/** 命令行 --token 优先于 SYNC_TOKEN；两边都没有就是空串（不鉴权，本机自用） */
const RAW_TOKEN = Array.isArray(args.token) ? args.token[0] : args.token
const TOKEN = String(
  typeof RAW_TOKEN === 'string' ? RAW_TOKEN : (process.env.SYNC_TOKEN ?? '')
).trim()

/** 额外放行的跨域来源（--allow-origin a,b 可重复，或 SYNC_ALLOWED_ORIGINS=a,b），小写存储 */
const EXTRA_ORIGINS = new Set(
  [
    ...(Array.isArray(args['allow-origin'])
      ? args['allow-origin']
      : [args['allow-origin']]),
    process.env.SYNC_ALLOWED_ORIGINS,
  ]
    .filter((value) => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
)

/** Windows 上 POSIX 权限位没有实际约束力，落盘只写不 chmod（靠 NTFS ACL） */
const IS_WINDOWS = process.platform === 'win32'
// ── 记录与合并规则（与 src/services/sync/{protocol,merge}.ts 对应） ─────────

/** 设置记录的固定 id（客户端 SETTINGS_RECORD_ID） */
const SETTINGS_RECORD_ID = 'device-agnostic'
/** 选中项记录的固定 id（客户端 PROMPT_SELECTION_RECORD_ID） */
const PROMPT_SELECTION_RECORD_ID = 'selected'
/** 提示词名 / 内容长度上限（客户端 PROMPT_NAME_MAX / PROMPT_CONTENT_MAX） */
const PROMPT_NAME_MAX = 60
const PROMPT_CONTENT_MAX = 4000

const LOCALES = ['zh-CN', 'en-US']
const THEME_PREFERENCES = ['light', 'dark', 'system']
const REASONING_EFFORTS = ['low', 'high', 'max']
const FONT_SCALES = ['small', 'normal', 'large']

/** 非负整数时间戳；非法一律 0 */
const stampOf = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * 校验并按白名单重建一份可同步设置（与客户端 src/services/sync/protocol.ts 的
 * sanitizeSyncedSettings 逐条对应，改一侧要同步改另一侧）。
 * 只保留这十个字段：apiKey、syncDeviceId、syncDeviceName、LAN 相关键即使被客户端塞进来，
 * 也会在这里消失，数据文件里因此不可能出现 API Key，也不会有设备名。
 * 设备名是本机身份，不参与同步；同步服务地址虽然同样偏本机，但按要求保留在同步范围内。
 */
function sanitizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { locale, themePreference, model, reasoningEffort, syncServerUrl } = value
  const { thinking, search, siderCollapsed, fontScale } = value
  if (!LOCALES.includes(locale) || !THEME_PREFERENCES.includes(themePreference)) return null
  if (!REASONING_EFFORTS.includes(reasoningEffort)) return null
  if (typeof model !== 'string' || !model) return null
  if (typeof thinking !== 'boolean' || typeof search !== 'boolean') return null
  if (typeof siderCollapsed !== 'boolean') return null
  if (typeof syncServerUrl !== 'string') return null
  // fontScale 是后加的键：老客户端写的记录里没有它，缺省按 normal 补齐，
  // 否则一份老记录会整条判非法，那台设备设置就再也同步不上
  const scale = fontScale === undefined || fontScale === null ? 'normal' : fontScale
  if (!FONT_SCALES.includes(scale)) return null
  const raw = value.location
  let location = null
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) return null
    const { region, province, city } = raw
    if (typeof region !== 'string' || !region) return null
    if (province !== undefined && typeof province !== 'string') return null
    if (city !== undefined && typeof city !== 'string') return null
    location = typeof province === 'string' ? { region, province } : { region }
    if (typeof city === 'string') location.city = city
  }
  return {
    locale,
    themePreference,
    fontScale: scale,
    location,
    model,
    reasoningEffort,
    thinking,
    search,
    siderCollapsed,
    syncServerUrl,
  }
}

/** 校验并重建一份提示词记录内容（id 必须与记录的 id 一致） */
function sanitizePrompt(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.id !== 'string' || value.id !== id) return null
  if (typeof value.name !== 'string' || !value.name || value.name.length > PROMPT_NAME_MAX) return null
  if (
    typeof value.content !== 'string' ||
    !value.content ||
    value.content.length > PROMPT_CONTENT_MAX
  ) {
    return null
  }
  return { id, name: value.name, content: value.content, createdAt: stampOf(value.createdAt) }
}

/** 校验并重建一份「当前选中项」记录内容 */
function sanitizeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const selectedId = value.selectedId
  if (selectedId !== null && typeof selectedId !== 'string') return null
  return { selectedId }
}

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
 *
 * 与客户端 src/services/sync/protocol.ts 的 normalizeRecord 逐条对应：
 * 两边对「合法」的判断不一致，会出现「一端认为要推、另一端整批 400」的僵局。
 *
 * @param value 请求体里的一条记录
 * @returns 规范化后的记录；不合法返回 null（由调用方整体拒绝，不留半个事务）
 */
function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { kind, id, sessionId, updatedAt, device, deletedAt, data } = value
  const known =
    kind === 'session' ||
    kind === 'message' ||
    kind === 'settings' ||
    kind === 'prompt' ||
    kind === 'prompt-selection'
  if (!known) return null
  if (typeof id !== 'string' || !id) return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return null
  if (typeof device !== 'string' || !device) return null
  if (deletedAt !== undefined && deletedAt !== null) {
    if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt)) return null
  }
  const tombstone = deletedAt !== undefined && deletedAt !== null
  // 设置与选中项是「永远存在」的整份记录，没有删除语义：墓碑一律非法
  if (tombstone && (kind === 'settings' || kind === 'prompt-selection')) return null
  if (kind === 'settings' && id !== SETTINGS_RECORD_ID) return null
  if (kind === 'prompt-selection' && id !== PROMPT_SELECTION_RECORD_ID) return null
  if (!tombstone && (!data || typeof data !== 'object' || Array.isArray(data))) return null
  if (kind === 'message' && typeof sessionId !== 'string') return null
  const record = { kind, id, updatedAt, device, data: null }
  if (kind === 'message') record.sessionId = sessionId
  if (tombstone) {
    record.deletedAt = deletedAt
    return record
  }
  if (kind === 'message') {
    if (data.role !== 'user' && data.role !== 'assistant') return null
    record.data = data
    return record
  }
  if (kind === 'session') {
    if (typeof data.id !== 'string' || typeof data.title !== 'string') return null
    record.data = data
    return record
  }
  if (kind === 'settings') {
    const settings = sanitizeSettings(data)
    if (!settings) return null
    record.data = settings
    return record
  }
  if (kind === 'prompt') {
    const prompt = sanitizePrompt(data, id)
    if (!prompt) return null
    record.data = prompt
    return record
  }
  const selection = sanitizeSelection(data)
  if (!selection) return null
  record.data = selection
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
      // 数据文件里是全量会话，POSIX 上目录 0700、文件 0600；
      // Windows 的 mode 只映射到只读位、改不了 ACL，这一步在那儿是空操作（靠 NTFS 目录继承）
      await fsp.mkdir(path.dirname(DATA), { recursive: true, mode: 0o700 })
      const tmp = DATA + '.tmp'
      await fsp.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
      if (!IS_WINDOWS) await fsp.chmod(tmp, 0o600).catch(() => {})
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

/** /api/health 的统计：活记录与墓碑分开数，设置/提示词单独计数 */
function stats() {
  let sessions = 0
  let messages = 0
  let prompts = 0
  let settings = 0
  let tombstones = 0
  for (const record of store.values()) {
    if (record.deletedAt != null) tombstones += 1
    if (record.kind === 'session' && record.deletedAt == null) sessions += 1
    if (record.kind === 'message' && record.deletedAt == null) messages += 1
    if (record.kind === 'prompt' && record.deletedAt == null) prompts += 1
    if (record.kind === 'settings' && record.deletedAt == null) settings += 1
  }
  return { records: store.size, sessions, messages, prompts, settings, tombstones }
}
// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * 本机回环的等价写法：网页拿不到 localhost / 127.0.0.1 的 Origin（这由浏览器按地址栏决定，
 * 页面伪造不了），所以回环来源按「本机可信」处理，端口不限 —— 这样 dev server(8090)、
 * 本地 Web 服务(7789) 不用额外配置就能连上，安全性并不因此下降。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Android WebView 外壳加载页面用的虚拟源（android/shell），属于产品自身的来源 */
const WEBVIEW_ORIGIN = 'https://dsapp.local'
/** --no-webview-origin 可关掉上面这条，只留「与请求 Host 同源」 */
const ALLOW_WEBVIEW_ORIGIN = args['no-webview-origin'] !== true

/**
 * origin 是否回环来源（http + 回环 host，端口不限）。
 * @param value 已小写化的 origin 字符串
 * @returns true = 本机来源
 * @remarks 用 URL 解析而不是拼字符串：顺带挡住 http://127.0.0.1:80@evil.example 这类混淆写法
 */
function isLoopbackOrigin(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
}

/**
 * 请求来源是否放行。
 * @param origin 请求头 Origin
 * @param hostHeader 请求头 Host，作为「同源」基准
 * @returns true = 放行（含无 Origin 的 curl / 同源窄导航）；false = 不回 CORS 头并 403
 * @remarks 刻意不默认放行 Origin: null —— 沙箱 iframe、data:/blob: 文档都会带 null，
 *   那等于给任意网页留一条读数据的路；要放行必须显式写进 --allow-origin。
 */
function originAllowed(origin, hostHeader) {
  if (typeof origin !== 'string' || !origin) return true
  const value = origin.trim().toLowerCase()
  if (EXTRA_ORIGINS.has(value)) return true
  if (ALLOW_WEBVIEW_ORIGIN && value === WEBVIEW_ORIGIN) return true
  // 与请求 Host 严格同源（局域网 IP 直连本服务这一路）
  const host = String(hostHeader ?? '').trim().toLowerCase()
  if (host && value === 'http://' + host) return true
  // 回环任意端口（本机 dev server / 本地 Web 服务）
  return isLoopbackOrigin(value)
}

/**
 * CORS 响应头：只有来源通过白名单才回 Access-Control-Allow-Origin，
 * 且回显具体来源（不用 *，避免把带口令的响应暴露给别的源）；不通过时一个 CORS 头都不回。
 * @param req 请求（读 Origin）
 * @param allowed 来源是否通过白名单
 */
function corsHeaders(req, allowed) {
  const origin = req.headers.origin
  return {
    ...(allowed && typeof origin === 'string' && origin
      ? { 'Access-Control-Allow-Origin': origin }
      : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sync-Token',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

/**
 * 从请求里取出口令：授权头 Bearer 或 X-Sync-Token 头。
 * @param req 请求
 * @returns 口令明文；没带返回空串
 */
function presentedToken(req) {
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.*)$/i.exec(auth.trim())
    if (match) return match[1].trim()
  }
  const header = req.headers['x-sync-token']
  return typeof header === 'string' ? header.trim() : ''
}

/**
 * 口令比对：定长比较，避免按字节短路带来的时序差。
 * @param presented 请求里带的口令
 * @returns 是否与已设口令一致；没设口令时恒为 false（调用方已先判空）
 */
function tokenMatches(presented) {
  if (!TOKEN || !presented) return false
  const expected = Buffer.from(TOKEN, 'utf8')
  const actual = Buffer.from(presented, 'utf8')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

/**
 * 发 JSON 响应。
 * @param allowed 来源是否通过白名单（默认 true：走到这里的请求都已过这道闸）
 * @remarks 口令永远不会出现在响应体或日志里
 */
function send(req, res, status, body, allowed = true) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...corsHeaders(req, allowed),
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

  // 来源闸：不在白名单的源一律 403 且不回任何 CORS 头（浏览器据此连响应体都读不到）。
  // 预检与真实请求走同一道闸，因此 Content-Type: text/plain 的「简单请求」也过不去。
  const origin = req.headers.origin
  const allowed = originAllowed(origin, req.headers.host)
  if (!allowed) {
    send(req, res, 403, { ok: false, error: '来源不在白名单' }, false)
    log(403, 'origin=' + String(origin))
    return
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req, allowed))
    res.end()
    log(204)
    return
  }

  // 口令闸：只锁 /api/*；OPTIONS 已在上面返回（浏览器预检不带自定义头）
  if (TOKEN && url.pathname.startsWith('/api/') && !tokenMatches(presentedToken(req))) {
    send(req, res, 401, {
      ok: false,
      error: '需要访问口令：Authorization: Bearer <token> 或 X-Sync-Token',
    })
    log(401, 'unauthorized')
    return
  }

  if (url.pathname === '/' && req.method === 'GET') {
    // 只报协议身份与端点清单：name 默认是主机名，不再对外返回
    send(req, res, 200, {
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      tokenRequired: TOKEN !== '',
      endpoints: ['GET /api/health', 'GET /api/state', 'POST /api/sync'],
    })
    log(200)
    return
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    // 只回协议身份、时间、是否设了口令与计数：主机名、数据文件绝对路径等一律不对外
    // （审计 SHOULD-4）。format 必须保留：客户端的 checkFormat 靠它认出「这是同步服务」。
    send(req, res, 200, {
      ok: true,
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      time: Date.now(),
      tokenRequired: TOKEN !== '',
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
  console.log('[sync] 名称 %s（仅本机日志，不再对外返回）', NAME)
  console.log(
    '[sync] 跨域白名单：回环任意端口 + 与请求 Host 同源%s',
    ALLOW_WEBVIEW_ORIGIN ? ' + ' + WEBVIEW_ORIGIN : ''
  )
  if (EXTRA_ORIGINS.size > 0) {
    console.log('[sync] 额外放行来源：%s', [...EXTRA_ORIGINS].join(', '))
  }
  if (TOKEN) {
    console.log('[sync] 访问口令：已启用（/api/* 需 Authorization: Bearer <口令> 或 X-Sync-Token）')
  } else {
    console.warn('[sync] ⚠ 未设口令，仅建议本机使用：能访问本端口的人都能读写全部会话')
    console.warn('[sync]   需要口令时加 --token <口令>，或设环境变量 SYNC_TOKEN')
    if (!LOOPBACK_HOSTS.has(String(HOST).toLowerCase())) {
      console.warn(
        '[sync] ⚠ 正在监听 %s 且无口令：局域网内任何设备都可能读写数据',
        HOST
      )
    }
  }
  if (IS_WINDOWS) {
    console.log('[sync] 数据文件权限：Windows 走 NTFS ACL，跳过 POSIX 0600 收紧')
  }
})
