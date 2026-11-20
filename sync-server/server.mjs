#!/usr/bin/env node
/**
 * 多端同步服务（M1）。零依赖：只用 node: 内置模块。
 *
 * 用法
 *   node sync-server/server.mjs [--port 7788] [--host 127.0.0.1] [--data <json 文件>] [--name <名称>]
 *   node sync-server/server.mjs --token <口令> [--allow-origin <来源>]
 *   node sync-server/server.mjs --host 0.0.0.0 --token <口令> [--public-host <host:port>]
 *   node sync-server/server.mjs --help
 *
 * 环境变量（命令行参数优先）
 *   SYNC_PORT / SYNC_HOST / SYNC_DATA / SYNC_NAME / SYNC_TOKEN / SYNC_ALLOWED_ORIGINS
 *   SYNC_PUBLIC_HOST
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
 * 证书指纹分发（自签 HTTPS 配对）
 *   启用 TLS 时本服务计算一次证书 DER 的 SHA-256，并**只**用它对外：
 *     - 启动日志打印一行（只打印指纹，私钥与证书内容一律不打印）
 *     - GET / 与 GET /api/health 的 certFingerprint 字段（HTTP 模式下为 null），
 *       同值保留旧字段名 tlsFingerprint 作为兼容别名
 *     - POST /api/group/create 与 POST /api/group/invite 的 certFingerprint
 *       （管理端/主机才走得到的两条路，网页版靠它把指纹展示给用户复制）
 *   格式与算法见 sync-server/cert-fingerprint.mjs（64 位小写十六进制、无分隔符，
 *   与 Android 的 Bridge.setSyncTlsPin / onReceivedSslError 判据逐字节等价）。
 *   注意：手机在固定指纹之前连不上本服务（WebView 会直接 cancel 自签证书），
 *   所以**手机拿指纹只能靠人工/二维码，不能靠它自己请求接口**——接口里的指纹是给
 *   电脑上的页面显示与复制用的。
 *
 * 二维码配对（配对串）
 *   POST /api/group/{create,invite} 除 code/expiresAt/certFingerprint 外，再返回一个
 *   pair 对象：{ uri, host, reachable, reason, candidates }。uri 是自描述串
 *     deepseek-sync://pair?v=1&h=<host:port>&c=<8位码>&f=<64hex>&x=<unix秒>
 *   由本服务组装（只有它知道手机能连的地址：网页永远在回环上，见 pair-uri.mjs 文件头），
 *   页面拿到 uri 后本地画二维码。老的客户端只读 invite.code，多出来的 pair 字段不影响它。
 *
 * 对局域网开放（默认不开）
 *   默认只监听 127.0.0.1。要手机直连必须同时给 --host <非回环> 与 --token：
 *   **非回环监听且没设口令时本进程拒绝启动**（不是警告），因为那等于把整库会话
 *   交给局域网里任何一台机器。
 *   --public-host <host:port> 显式指定「手机该连哪里」，优先于自动枚举网卡；
 *   反代 / 端口映射 / 域名这些服务端自己推不出来的场景用它。
 *
 * 存储
 *   一个 JSON 文件，原子写（先写 .tmp 再 rename），写入去抖 200ms，退出前强制落盘。
 *   文件结构：{ format, version, updatedAt, records: { "kind:id": record } }
 *   读：/api/{health,state,sync} 处理前先 stat 一次（mtime+size），文件被外部改过（lan-peer 的
 *   P2P 合并、手工编辑、另一个实例）就重读并按 LWW 并进内存 —— **数据文件被外部更新后不需要
 *   重启本服务**。读失败（正被原子 rename 替换）最多重试 3 次，仍失败就先用内存视图应答。
 */

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { certFingerprintFromPem, normalizeCertFingerprint } from './cert-fingerprint.mjs'
import {
  PAIR_CODE_ALPHABET,
  buildPairUri,
  normalizePairHost,
  resolvePairTarget,
} from './pair-uri.mjs'

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
      '      node sync-server/server.mjs --host 0.0.0.0 --token <口令> [--public-host <host:port>]',
      '',
      '  --port   监听端口，默认 7788（也可用 SYNC_PORT）',
      '  --host   监听地址，默认 127.0.0.1；局域网内其它设备要连时用 0.0.0.0（也可用 SYNC_HOST）',
      '           监听非回环地址时必须同时给 --token，否则拒绝启动',
      '  --public-host  手机该连的地址，如 192.168.1.10:7788；给反代/端口映射/域名用，',
      '           优先于自动枚举网卡（也可用 SYNC_PUBLIC_HOST）',
      '  --data   数据文件，默认 sync-server/data/sync-data.json（也可用 SYNC_DATA）',
      '  --name   本机日志里显示的名字，默认取主机名；不再对外返回（也可用 SYNC_NAME）',
      '  --token  访问口令；设了之后所有 /api/* 都要带 Authorization: Bearer <口令>',
      '           或 X-Sync-Token 头，否则 401（也可用 SYNC_TOKEN）',
      '  --tls-cert  PEM 证书路径；与 --tls-key 同时给时启用 HTTPS（也可用 SYNC_TLS_CERT）',
      '  --tls-key   PEM 私钥路径；与 --tls-cert 同时给时启用 HTTPS（也可用 SYNC_TLS_KEY）',
      '  --allow-origin  额外放行的跨域来源，逗号分隔可写多个，可重复给（也可用 SYNC_ALLOWED_ORIGINS）',
      '  --no-webview-origin  不放行 Android 外壳的 https://dsapp.local 来源',
      '',
      '启用 HTTPS 时启动日志会打印证书 SHA-256 指纹（64 位小写十六进制），',
      '手机端「多端同步 → 证书指纹」填的就是这一串；换证书后要重新固定。',
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

/**
 * 本机回环的等价写法。
 * 两处用途：① 判断 --host 是不是「只给本机用」（非回环 + 无口令 = 拒绝启动）；
 * ② 判断请求 Origin 是不是本机来源（网页拿不到 localhost/127.0.0.1 的 Origin，
 *    这由浏览器按地址栏决定，页面伪造不了）。回环来源按「本机可信」处理、端口不限，
 *    这样 dev server(8090)、本地 Web 服务(7789) 不用额外配置就能连上，安全性并不因此下降。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 显式指定的对外地址（--public-host / SYNC_PUBLIC_HOST），空串表示没给。
 * 只有服务端自己推不出「手机该连哪里」时才需要它：反代、端口映射、域名。
 */
const PUBLIC_HOST = String(
  (Array.isArray(args['public-host']) ? args['public-host'][0] : args['public-host']) ??
    process.env.SYNC_PUBLIC_HOST ??
    ''
).trim()

if (PUBLIC_HOST && !normalizePairHost(PUBLIC_HOST, PORT)) {
  console.error('[sync] --public-host 不合法：', PUBLIC_HOST, '（要 host[:port]，如 192.168.1.10:7788）')
  process.exit(1)
}

// ── 访问口令与跨域来源白名单 ────────────────────────────────────────────────

/** 命令行 --token 优先于 SYNC_TOKEN；两边都没有就是空串（不鉴权，本机自用） */
const RAW_TOKEN = Array.isArray(args.token) ? args.token[0] : args.token
const TOKEN = String(
  typeof RAW_TOKEN === 'string' ? RAW_TOKEN : (process.env.SYNC_TOKEN ?? '')
).trim()

// 对局域网开放 = 把整库会话交给局域网里任何一台机器。这是「必须同时给口令」的硬闸，
// 不是警告：默认部署只监听 127.0.0.1，安全取向由此保证（见文件头的「对局域网开放」）。
if (!LOOPBACK_HOSTS.has(HOST.trim().toLowerCase()) && TOKEN === '') {
  console.error('[sync] 拒绝启动：--host %s 会监听非回环地址，但没有 --token / SYNC_TOKEN', HOST)
  console.error('[sync]   局域网里任何设备都能读写全部会话；要么加口令，要么改回 127.0.0.1：')
  console.error('[sync]   node sync-server/server.mjs --host %s --token <口令>', HOST)
  process.exit(1)
}

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

// ── HTTPS ───────────────────────────────────────────────────────────────────

/** 证书与私钥路径；两边都给才启用 HTTPS，只给一边视为配置错误 */
const TLS_CERT_PATH = String(
  (Array.isArray(args['tls-cert']) ? args['tls-cert'][0] : args['tls-cert']) ??
    process.env.SYNC_TLS_CERT ??
    ''
).trim()
const TLS_KEY_PATH = String(
  (Array.isArray(args['tls-key']) ? args['tls-key'][0] : args['tls-key']) ??
    process.env.SYNC_TLS_KEY ??
    ''
).trim()

/**
 * 读证书与私钥，并算一次规范格式的证书指纹（64 位小写十六进制，见 cert-fingerprint.mjs）。
 *
 * @returns {Promise<{ cert: Buffer, key: Buffer, fingerprint: string } | null>}
 *   未配置 TLS 时 null（fingerprint 也就没有）；证书读不了直接退出
 */
async function loadTls() {
  if (!TLS_CERT_PATH && !TLS_KEY_PATH) {
    return null
  }
  if (!TLS_CERT_PATH || !TLS_KEY_PATH) {
    console.error('[sync] --tls-cert 与 --tls-key 必须同时提供')
    process.exit(1)
  }
  try {
    const [cert, key] = await Promise.all([
      fsp.readFile(TLS_CERT_PATH),
      fsp.readFile(TLS_KEY_PATH),
    ])
    // 不用 X509Certificate.fingerprint256：那是 "AB:CD:…" 的大写冒号写法，
    // 与手机端 [0-9a-f]{64} 的判据对不上。这里统一走 cert-fingerprint.mjs。
    return { cert, key, fingerprint: certFingerprintFromPem(cert) }
  } catch (error) {
    console.error('[sync] 读取 TLS 证书/私钥失败：', error.message)
    process.exit(1)
  }
}

const TLS = await loadTls()

// ── 组与配对 ────────────────────────────────────────────────────────────────

/** 组成员与配对信息；与业务数据分文件，避免把令牌哈希混进同步记录 */
const GROUP_FILE = path.join(path.dirname(DATA), 'group.json')
/** 配对码有效时长 */
const INVITE_TTL_MS = 10 * 60 * 1000
/** 设备令牌只存 SHA-256，明文只在创建/加入时返回一次 */
let group = null
let groupSaveChain = Promise.resolve()
/**
 * 配对码字符集：去掉 0/O/1/I 等易混字符。
 * 与 pair-uri.mjs 的 PAIR_CODE_ALPHABET 是同一份（那边负责解析校验，这里负责生成），
 * 不许各写一套 —— 两边差一个字符就会「生成的码解析器永远认不出」。
 */
const CODE_ALPHABET = PAIR_CODE_ALPHABET

const hashToken = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex')

/** 生成一次设备令牌（明文） */
const newDeviceToken = () => crypto.randomBytes(24).toString('base64url')

/** 生成一次性配对码 */
const newInviteCode = () =>
  Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('')

/** 组的对外视图：绝不包含 tokenHash */
const publicGroup = () =>
  group
    ? {
        groupId: group.groupId,
        groupName: group.groupName,
        hostDeviceId: group.hostDeviceId,
        epoch: group.epoch,
        createdAt: group.createdAt,
        devices: Object.values(group.devices).map((device) => ({
          id: device.id,
          name: device.name,
          canHost: device.canHost === true,
          joinedAt: device.joinedAt,
          lastSeenAt: device.lastSeenAt ?? null,
        })),
      }
    : null

/**
 * 建组/生成配对码响应里的 pair 字段（二维码内容与它所在的上下文）。
 *
 * uri 由服务端拼，理由见 pair-uri.mjs 文件头：网页永远在回环上，拿不到手机可连的地址。
 * reachable=false 时不编造地址（uri 为 null），页面据此改画「怎么开局域网模式」的说明 ——
 * 给一个连不上的地址比不给更糟（用户会拿着手机反复试）。
 *
 * @param {object} input
 * @param input.code 本次配对的明文码（只在这里与 invite 响应里出现，服务端只存 hash）
 * @param input.expiresAt 过期时间（毫秒）
 * @returns {{ uri: string | null, host: string | null, reachable: boolean,
 *             reason: 'loopback' | 'no-address' | null, candidates: string[] }}
 */
function pairPayload({ code, expiresAt }) {
  const target = resolvePairTarget({ listenHost: HOST, port: PORT, publicHost: PUBLIC_HOST })
  const uri =
    target.reachable && target.host
      ? buildPairUri({
          host: target.host,
          code,
          fingerprint: TLS?.fingerprint ?? null,
          expiresAt,
        })
      : null
  return {
    uri,
    host: target.host,
    reachable: target.reachable,
    reason: target.reason,
    candidates: target.candidates,
  }
}

/** 原子落盘 group.json（串行，避免并发写坏） */
const saveGroup = () => {
  const payload = JSON.stringify(group, null, 2)
  groupSaveChain = groupSaveChain
    .then(async () => {
      await fsp.mkdir(path.dirname(GROUP_FILE), { recursive: true, mode: 0o700 })
      const tmp = GROUP_FILE + '.tmp'
      await fsp.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
      if (!IS_WINDOWS) await fsp.chmod(tmp, 0o600).catch(() => {})
      await fsp.rename(tmp, GROUP_FILE)
    })
    .catch((error) => {
      console.error('[sync] 组信息落盘失败:', error.message)
    })
  return groupSaveChain
}

/** 启动时读组信息；坏数据按「没有组」处理，不让服务起不来 */
const loadGroup = async () => {
  try {
    const text = await fsp.readFile(GROUP_FILE, 'utf8')
    const parsed = JSON.parse(text)
    if (
      parsed &&
      typeof parsed.groupId === 'string' &&
      typeof parsed.hostDeviceId === 'string' &&
      Number.isInteger(parsed.epoch) &&
      parsed.devices &&
      typeof parsed.devices === 'object'
    ) {
      group = parsed
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[sync] 读取组信息失败（按无组处理）:', error.message)
    }
  }
}

/** 从请求头取设备令牌；与全局口令复用同一组头 */
const deviceByToken = (presented) => {
  if (!group || !presented) return null
  const hash = hashToken(presented)
  for (const device of Object.values(group.devices)) {
    if (device.tokenHash === hash) return device
  }
  return null
}

/**
 * 一次请求的鉴权结果。
 * @returns {{ device: object|null, legacy: boolean } | null} null 表示未通过
 */
const authenticate = (req) => {
  const presented = presentedToken(req)
  if (!presented) return null
  if (TOKEN && tokenMatches(presented)) {
    return { device: null, legacy: true }
  }
  const device = deviceByToken(presented)
  return device ? { device, legacy: false } : null
}

/** 记录设备最近一次出现；60 秒内不重复落盘 */
const touchDevice = (device) => {
  if (!device) return
  const now = Date.now()
  if (now - (device.lastSeenAt ?? 0) < 60_000) return
  device.lastSeenAt = now
  void saveGroup()
}

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
/**
 * 内存这份视图对应磁盘上的哪个版本，形如 `<mtimeMs>:<size>`；null 表示还没跟磁盘对过账。
 * 用途见 reconcileWithDisk：指纹不一致 = 文件被外部改过（lan-peer 的 P2P 合并、手工编辑、
 * 另一个 7788 实例），需要重读。
 */
let diskSignature = null
/** 文件正被原子 rename 替换时读会失败：最多重试几次、每次间隔多少毫秒 */
const RELOAD_ATTEMPTS = 3
const RELOAD_RETRY_MS = 15
/** 落盘失败后的自动重试截止时间（毫秒时间戳，0 = 没有在重试窗口里） */
const FLUSH_RETRY_WINDOW_MS = 10_000
let flushRetryDeadline = 0

/** 小睡一下（重试退避用） */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 数据文件的版本指纹：(mtimeMs, size)。
 *
 * 只做一次 stat，不读内容 —— 它在每个 /api/{health,state,sync} 处理前都会被调用，必须便宜。
 * mtime 与 size 同时不变的「不同内容」几乎不可能出现：本文件是整份 JSON，任何记录变化都会
 * 改 size；即使 size 撞车（比如同时一增一删），mtime 也会变。
 *
 * @returns 指纹字符串；文件不存在时为 ''（表示「磁盘上还没有文件」）
 * @throws 除 ENOENT 外的 stat 失败（权限等）原样抛出，由调用方记日志后继续用内存
 */
async function statSignature() {
  try {
    const stat = await fsp.stat(DATA)
    return stat.mtimeMs + ':' + stat.size
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * 从磁盘读一份完整视图并规范化。
 *
 * @returns 记录表；文件不存在或不是本服务的格式时 null（调用方保留现有内存视图）
 * @throws 读失败（被占用 / 半截 JSON）时原样抛出，由调用方重试
 */
async function readStoreFromDisk() {
  let text
  try {
    text = await fsp.readFile(DATA, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // 正常路径不会出现（写入方都是「临时文件 + rename」的原子写）；真撞上就让调用方重试
    throw new Error('数据文件不是合法 JSON：' + error.message)
  }
  if (parsed?.format !== SYNC_FORMAT) return null
  const records = new Map()
  for (const [key, value] of Object.entries(parsed.records ?? {})) {
    const record = normalizeRecord(value)
    if (record) records.set(key, record)
  }
  return records
}

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
      // 记下自己这一版的指纹：免得下一次请求把刚写下去的内容当成「外部改动」又重读一遍
      diskSignature = await statSignature()
      flushRetryDeadline = 0
    })
    .catch((error) => {
      console.error('[sync] 落盘失败:', error.message)
      // 失败时脏标记已被清掉，但内存里的记录还在、磁盘上还没有：置回脏再排一次。
      // 只有「已经有新改动在排队」（dirty 为真）时才不用管 —— 那一轮会把最新全量写下去。
      if (dirty) {
        return
      }
      const now = Date.now()
      if (flushRetryDeadline === 0) {
        flushRetryDeadline = now + FLUSH_RETRY_WINDOW_MS
        console.warn(
          '[sync] 落盘重试：内存里的记录还没写到磁盘，最多再试 %d 秒（每 %dms 一次）',
          FLUSH_RETRY_WINDOW_MS / 1000,
          FLUSH_DELAY
        )
      }
      if (now < flushRetryDeadline) {
        markDirty()
        return
      }
      flushRetryDeadline = 0
      console.error('[sync] 落盘连续失败超过 %d 秒，停止自动重试；等下一次改动再写', FLUSH_RETRY_WINDOW_MS / 1000)
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

/**
 * 把磁盘上的记录按 LWW 并进内存（是「合并」而不是「整份替换」）。
 *
 * 为什么不是替换：文件可能是一份比内存更旧的快照（例如 lan-peer 读到旧版本后又整份写回），
 * 整份替换会把内存里刚接受、还没落盘的记录悄悄丢掉。按 compareRecords 合并则只做「谁更新
 * 谁赢」，两个方向都不会丢：外部的新记录被采纳，本地更新的记录保留。
 *
 * @param incoming 从磁盘读出来的记录表
 * @returns 采纳统计；collapsed 是被会话墓碑连带墓碑化的消息数
 */
function adoptRecords(incoming) {
  let added = 0
  let updated = 0
  for (const [key, record] of incoming) {
    const existing = store.get(key)
    if (!existing) {
      store.set(key, record)
      added += 1
      continue
    }
    if (compareRecords(record, existing) > 0) {
      store.set(key, record)
      updated += 1
    }
  }
  // 外部带来的会话墓碑要立刻把它的消息也墓碑化（与客户端同一套规则，见 collapseDeletedSessions）
  const collapsed = collapseDeletedSessions(store)
  return { added, updated, collapsed }
}

/**
 * 数据文件被外部改过就重读并并进内存 —— **不需要重启本服务**。
 *
 * 触发场景：手机把记录 P2P 推给 lan-peer，lan-peer 原子写同一份 JSON；本服务常驻内存，
 * 不主动看文件就永远报着旧数据。这里在每个 /api/{health,state,sync} 处理前先 stat 一次
 * （只 stat、不读内容，开销可忽略），指纹变了才真正重读。
 *
 * 并发：写入方都是「临时文件 + rename」的原子写，读到的要么是旧版本要么是新版本，不会是半截；
 * 但 Windows 上替换的瞬间可能 EBUSY/EPERM，所以读失败重试 3 次、每次 15ms，日志写明第几次；
 * 3 次都失败就先用内存视图应答（调用方照常返回 200），下次请求再对账 —— 不 500、不空响应。
 *
 * @param where 调用点（写进日志，便于和 curl / 页面操作对齐）
 * @returns Promise<void>
 * @sideeffect 可能触发一次落盘（采纳了外部记录时，把合并后的并集写回文件）
 */
async function reconcileWithDisk(where) {
  // 自己的改动还在 200ms 防抖窗口里：先落盘，否则下面会读到不含它们的旧文件
  if (dirty) {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    await flush()
  }
  let signature
  try {
    signature = await statSignature()
  } catch (error) {
    console.warn('[sync] 检查数据文件失败（%s）：%s', where, error.message)
    return
  }
  if (signature === diskSignature) return

  for (let attempt = 1; attempt <= RELOAD_ATTEMPTS; attempt += 1) {
    try {
      const records = await readStoreFromDisk()
      if (records === null) {
        // 文件被删掉或不是本服务格式：保留内存视图，记下指纹，等它回来再对账
        diskSignature = signature
        return
      }
      // 读完再看一眼 stat：读的瞬间正被替换的话指纹会变，这份内容可能已经过期
      const after = await statSignature()
      if (after !== signature) {
        signature = after
        if (attempt < RELOAD_ATTEMPTS) {
          await sleep(RELOAD_RETRY_MS)
          continue
        }
      }
      const applied = adoptRecords(records)
      const before = diskSignature
      diskSignature = after
      console.log(
        '[sync] 数据文件被外部更新（%s → %s）：读回 %d 条，新增 %d、更新 %d、墓碑化 %d（%s）',
        String(before),
        String(after),
        records.size,
        applied.added,
        applied.updated,
        applied.collapsed,
        where
      )
      if (applied.added > 0 || applied.updated > 0 || applied.collapsed > 0) markDirty()
      return
    } catch (error) {
      console.warn(
        '[sync] 重读数据文件失败（第 %d/%d 次，%s）：%s',
        attempt,
        RELOAD_ATTEMPTS,
        where,
        error.message
      )
      if (attempt === RELOAD_ATTEMPTS) {
        console.warn('[sync] 放弃本次重读，先按内存视图应答（下次请求再试）')
        return
      }
      await sleep(RELOAD_RETRY_MS)
    }
  }
}

/**
 * 启动时把数据文件读进内存，并记下版本指纹。
 *
 * @returns Promise<void>
 * @sideeffect 覆盖 store / diskSignature；读不到时按空库启动（不退出）
 */
async function load() {
  let signature = null
  try {
    signature = await statSignature()
  } catch {
    signature = null
  }
  const records = await readStoreFromDisk().catch((error) => {
    console.warn('[sync] 读不到存档（%s），按空库启动：%s', error.message, DATA)
    return null
  })
  if (records === null) {
    if (signature === '') {
      console.log('[sync] 新建数据文件：%s', DATA)
    } else {
      console.warn('[sync] 数据文件不是本服务的格式，按空库启动：%s', DATA)
    }
  } else {
    store = records
    console.log('[sync] 已载入 %d 条记录：%s', store.size, DATA)
  }
  diskSignature = signature
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

/** 读 JSON 请求体；空体或坏 JSON 返回 null */
async function readJsonBody(req) {
  const text = await readBody(req)
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
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

const requestHandler = async (req, res) => {
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

  // 口令 / 设备令牌闸：只锁 /api/*；OPTIONS 已在上面返回（浏览器预检不带自定义头）
  const auth = authenticate(req)
  const isApi = url.pathname.startsWith('/api/')
  const openGroupRoute =
    (url.pathname === '/api/group' && req.method === 'GET') ||
    url.pathname === '/api/group/join' ||
    (url.pathname === '/api/group/create' && group === null)
  const groupProtected =
    url.pathname === '/api/state' ||
    url.pathname === '/api/sync' ||
    (url.pathname.startsWith('/api/group/') && !openGroupRoute)
  if (
    (TOKEN && isApi && !openGroupRoute && !auth) ||
    (!TOKEN && group && groupProtected && !auth)
  ) {
    send(req, res, 401, {
      ok: false,
      error: '需要访问凭证：Authorization: Bearer <设备令牌或口令> / X-Sync-Token',
    })
    log(401, 'unauthorized')
    return
  }
  if (auth) {
    touchDevice(auth.device)
  }

  if (url.pathname === '/' && req.method === 'GET') {
    // 只报协议身份与端点清单：name 默认是主机名，不再对外返回
    send(req, res, 200, {
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      tokenRequired: TOKEN !== '',
      tls: TLS !== null,
      // 规范格式（64 位小写十六进制）；HTTP 模式下为 null。
      // tlsFingerprint 是 PR #3 起的旧字段名，同值保留，客户端已改为优先读 certFingerprint。
      certFingerprint: TLS?.fingerprint ?? null,
      tlsFingerprint: TLS?.fingerprint ?? null,
      endpoints: [
        'GET /api/health',
        'GET /api/state',
        'POST /api/sync',
        'GET /api/group',
        'POST /api/group/create',
        'POST /api/group/join',
        'POST /api/group/invite',
        'POST /api/group/host',
        'POST /api/group/revoke',
      ],
    })
    log(200)
    return
  }

  if (url.pathname === '/api/group' && req.method === 'GET') {
    send(req, res, 200, { ok: true, group: publicGroup() })
    log(200)
    return
  }

  if (url.pathname === '/api/group/create' && req.method === 'POST') {
    if (group) {
      send(req, res, 409, { ok: false, error: '组已存在，请改用加入组' })
      log(409, 'group-exists')
      return
    }
    const body = await readJsonBody(req)
    const device = typeof body?.device === 'string' ? body.device.trim() : ''
    if (!device) {
      send(req, res, 400, { ok: false, error: '缺少 device' })
      log(400, 'bad-device')
      return
    }
    const now = Date.now()
    const token = newDeviceToken()
    const code = newInviteCode()
    group = {
      groupId: 'grp-' + crypto.randomBytes(4).toString('hex'),
      groupName:
        typeof body.groupName === 'string' && body.groupName.trim()
          ? body.groupName.trim().slice(0, 40)
          : '我的设备',
      createdAt: now,
      hostDeviceId: device,
      epoch: 1,
      devices: {
        [device]: {
          id: device,
          name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : device,
          tokenHash: hashToken(token),
          canHost: body.canHost !== false,
          joinedAt: now,
          lastSeenAt: now,
        },
      },
      invite: { codeHash: hashToken(code), expiresAt: now + INVITE_TTL_MS },
    }
    await saveGroup()
    send(req, res, 200, {
      ok: true,
      group: publicGroup(),
      deviceToken: token,
      invite: { code, expiresAt: group.invite.expiresAt },
      // 建组的人就是主机（管理端）：把证书指纹一并给他，电脑上的页面才能显示/复制
      certFingerprint: TLS?.fingerprint ?? null,
      // 二维码内容：串由服务端拼（只有它知道手机能连的地址），页面只负责画矩阵
      pair: pairPayload({ code, expiresAt: group.invite.expiresAt }),
    })
    log(200, 'group-created')
    return
  }

  if (url.pathname === '/api/group/join' && req.method === 'POST') {
    if (!group) {
      send(req, res, 404, { ok: false, error: '还没有组，请先在主机上创建组' })
      log(404, 'no-group')
      return
    }
    const body = await readJsonBody(req)
    const code = typeof body?.code === 'string' ? body.code.replace(/\s+/g, '').toUpperCase() : ''
    const device = typeof body?.device === 'string' ? body.device.trim() : ''
    if (!code || !device) {
      send(req, res, 400, { ok: false, error: '缺少配对码或 device' })
      log(400, 'bad-join')
      return
    }
    const invite = group.invite
    if (
      !invite ||
      invite.expiresAt < Date.now() ||
      hashToken(code) !== invite.codeHash
    ) {
      send(req, res, 403, { ok: false, error: '配对码无效或已过期' })
      log(403, 'bad-invite')
      return
    }
    const now = Date.now()
    const token = newDeviceToken()
    const existing = group.devices[device]
    group.devices[device] = {
      id: device,
      name:
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 40)
          : (existing?.name ?? device),
      tokenHash: hashToken(token),
      canHost: body.canHost === true || existing?.canHost === true,
      joinedAt: existing?.joinedAt ?? now,
      lastSeenAt: now,
    }
    // 一次性配对码：成功加入即作废
    delete group.invite
    await saveGroup()
    send(req, res, 200, { ok: true, group: publicGroup(), deviceToken: token })
    log(200, 'group-joined')
    return
  }

  if (url.pathname === '/api/group/invite' && req.method === 'POST') {
    if (!group) {
      send(req, res, 404, { ok: false, error: '还没有组' })
      log(404, 'no-group')
      return
    }
    const isHost = auth?.legacy || (auth?.device && auth.device.id === group.hostDeviceId)
    if (!isHost) {
      send(req, res, 403, { ok: false, error: '只有主机能生成配对码' })
      log(403, 'not-host')
      return
    }
    const code = newInviteCode()
    const expiresAt = Date.now() + INVITE_TTL_MS
    group.invite = { codeHash: hashToken(code), expiresAt }
    await saveGroup()
    send(req, res, 200, {
      ok: true,
      invite: { code, expiresAt },
      certFingerprint: TLS?.fingerprint ?? null,
      pair: pairPayload({ code, expiresAt }),
    })
    log(200, 'invite-created')
    return
  }

  if (url.pathname === '/api/group/host' && req.method === 'POST') {
    if (!group) {
      send(req, res, 404, { ok: false, error: '还没有组' })
      log(404, 'no-group')
      return
    }
    const body = await readJsonBody(req)
    const targetId = typeof body?.targetDeviceId === 'string' ? body.targetDeviceId.trim() : ''
    if (!targetId || !group.devices[targetId]) {
      send(req, res, 404, { ok: false, error: '目标设备不在组里' })
      log(404, 'no-target')
      return
    }
    if (body.epoch !== group.epoch) {
      send(req, res, 409, { ok: false, error: 'epoch_stale', group: publicGroup() })
      log(409, 'epoch-stale')
      return
    }
    if (group.devices[targetId].canHost !== true) {
      send(req, res, 409, { ok: false, error: '目标设备不能当主机' })
      log(409, 'cannot-host')
      return
    }
    if (targetId !== group.hostDeviceId) {
      group.hostDeviceId = targetId
      group.epoch += 1
      await saveGroup()
    }
    send(req, res, 200, { ok: true, group: publicGroup() })
    log(200, 'host-changed')
    return
  }

  if (url.pathname === '/api/group/revoke' && req.method === 'POST') {
    if (!group) {
      send(req, res, 404, { ok: false, error: '还没有组' })
      log(404, 'no-group')
      return
    }
    const isHost = auth?.legacy || (auth?.device && auth.device.id === group.hostDeviceId)
    if (!isHost) {
      send(req, res, 403, { ok: false, error: '只有主机能移除设备' })
      log(403, 'not-host')
      return
    }
    const body = await readJsonBody(req)
    const targetId = typeof body?.targetDeviceId === 'string' ? body.targetDeviceId.trim() : ''
    if (!targetId || !group.devices[targetId]) {
      send(req, res, 404, { ok: false, error: '目标设备不在组里' })
      log(404, 'no-target')
      return
    }
    if (targetId === group.hostDeviceId) {
      send(req, res, 409, { ok: false, error: '不能移除主机自己，请先更换主机' })
      log(409, 'remove-host')
      return
    }
    delete group.devices[targetId]
    await saveGroup()
    send(req, res, 200, { ok: true, group: publicGroup() })
    log(200, 'device-revoked')
    return
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    // 处理前先对账：手机 P2P 推给 lan-peer 的记录写在文件里，不重读就一直是旧数字
    await reconcileWithDisk('GET /api/health')
    // 只回协议身份、时间、是否设了口令与计数：主机名、数据文件绝对路径等一律不对外
    // （审计 SHOULD-4）。format 必须保留：客户端的 checkFormat 靠它认出「这是同步服务」。
    send(req, res, 200, {
      ok: true,
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      time: Date.now(),
      tokenRequired: TOKEN !== '',
      tls: TLS !== null,
      certFingerprint: TLS?.fingerprint ?? null,
      tlsFingerprint: TLS?.fingerprint ?? null,
      groupId: group?.groupId ?? null,
      groupName: group?.groupName ?? null,
      hostDeviceId: group?.hostDeviceId ?? null,
      groupEpoch: group?.epoch ?? null,
      groupDevices: group ? Object.keys(group.devices).length : 0,
      ...stats(),
    })
    log(200)
    return
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    await reconcileWithDisk('GET /api/state')
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
    // 合并前先并进外部改动，否则客户端推上来的记录会盖掉文件里刚到的 P2P 数据
    await reconcileWithDisk('POST /api/sync')
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
    if (group && Number.isInteger(payload?.epoch) && payload.epoch < group.epoch) {
      send(req, res, 409, { ok: false, error: 'epoch_stale', group: publicGroup() })
      log(409, 'epoch-stale')
      return
    }
    if (auth?.device && payload?.device !== auth.device.id) {
      send(req, res, 403, { ok: false, error: 'device 与设备令牌不一致' })
      log(403, 'device-mismatch')
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
}

const server = TLS
  ? https.createServer({ cert: TLS.cert, key: TLS.key }, requestHandler)
  : http.createServer(requestHandler)

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
  await groupSaveChain
  console.log('[sync] 已退出')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGHUP', () => void shutdown('SIGHUP'))

await load()
await loadGroup()
server.listen(PORT, HOST, () => {
  const scheme = TLS ? 'https' : 'http'
  console.log('[sync] %s v%d 监听 %s://%s:%d', SYNC_FORMAT, SYNC_VERSION, scheme, HOST, PORT)
  if (TLS) {
    // 只打印指纹：证书内容与私钥一律不出现在日志里。手机上要人工/扫码带入这一串
    console.log('[sync] 证书 SHA-256 指纹：%s', TLS.fingerprint)
    console.log('[sync] 把这 64 位指纹填进手机「多端同步 → 证书指纹」，或让反代用同一张证书校验')
    console.log('[sync] 换证书（重新 gen-cert）后指纹会变，手机需要重新固定一次')
  } else {
    console.warn('[sync] ⚠ 当前是明文 HTTP：只建议回环使用，局域网请加 --tls-cert / --tls-key')
  }
  console.log('[sync] 数据文件 %s', DATA)
  console.log('[sync] 名称 %s（仅本机日志，不再对外返回）', NAME)
  if (group) {
    console.log(
      '[sync] 组 %s（%s），主机 %s，epoch %d，成员 %d',
      group.groupId,
      group.groupName,
      group.hostDeviceId,
      group.epoch,
      Object.keys(group.devices).length
    )
  } else {
    console.log('[sync] 未建组：客户端可在设置里创建组，再用配对码加入')
  }
  console.log(
    '[sync] 跨域白名单：回环任意端口 + 与请求 Host 同源%s',
    ALLOW_WEBVIEW_ORIGIN ? ' + ' + WEBVIEW_ORIGIN : ''
  )
  if (EXTRA_ORIGINS.size > 0) {
    console.log('[sync] 额外放行来源：%s', [...EXTRA_ORIGINS].join(', '))
  }
  // 扫码配对：把「手机该连哪里」说清楚。默认部署只监听回环，所以这里多半是一句能照做的命令
  // 而不是一个地址 —— 与响应里 pair.reachable 的取值同源（pair-uri.mjs 的 resolvePairTarget）。
  const pairTarget = resolvePairTarget({ listenHost: HOST, port: PORT, publicHost: PUBLIC_HOST })
  if (pairTarget.reachable) {
    console.log('[sync] 扫码配对：手机连 %s（二维码在页面「扫码配对」卡片里，含配对码与证书指纹）', pairTarget.host)
    if (pairTarget.candidates.length > 1) {
      console.log('[sync]   本机其它可用地址：%s（要改用 --public-host 指定）', pairTarget.candidates.slice(1).join(', '))
    }
  } else if (pairTarget.reason === 'loopback') {
    console.log('[sync] 扫码配对不可用：只监听 %s，手机连上去等于连自己', HOST)
    console.log('[sync]   要手机直连：node sync-server/server.mjs --host 0.0.0.0 --token <口令>')
  } else {
    console.log('[sync] 扫码配对不可用：没找到能拿给手机用的局域网地址')
    console.log('[sync]   用 --public-host <host:port> 显式指定（反代 / 端口映射 / 域名场景）')
  }
  if (TOKEN) {
    console.log('[sync] 访问口令：已启用（/api/* 需 Authorization: Bearer <口令> 或 X-Sync-Token）')
    // 「对局域网开放」是部署侧的关键事实，必须在不看启动命令的人也看得见的地方出现一次：
    // start.ps1 用 -Lan 起来时也会打一行同样的话（那边是脚本级，这里是服务端自报）。
    if (!LOOPBACK_HOSTS.has(String(HOST).toLowerCase())) {
      console.log('[sync] 已对局域网开放：监听 %s（口令已启用，局域网内其它设备可访问）', HOST)
    }
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
