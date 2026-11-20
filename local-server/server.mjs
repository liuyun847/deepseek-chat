/**
 * 本机 Web 服务：把 dist/ 静态托管给浏览器，并把 DeepSeek API 反向代理到上游。
 *
 * 为什么要多这一层
 * ================
 * 纯静态的 dist/ 只能让浏览器直连 https://api.deepseek.com，key 就不得不写进前端产物 ——
 * 产物是明文 JS，谁打开页面谁都能拿到 key。这个服务把 key 留在服务端（环境变量或
 * .secrets/api-key.txt），浏览器只请求同源的 /anthropic/*，由服务端注入鉴权头后转发。
 *
 * 四条路由
 * ========
 *   GET  /api/health     服务状态（是否有 key 只给布尔，绝不回显 key）
 *   *    /anthropic/*    反向代理到 ${UPSTREAM}/anthropic/*
 *   GET  /models         反向代理到 ${UPSTREAM}/models（客户端用它拉模型列表）
 *   *    /sync/api/*     反向代理到同步服务（sync-server，默认 127.0.0.1:7788）的 /api/*
 *   其它                 静态文件；找不到且没有扩展名时回落到 index.html（SPA）
 *
 * 为什么同步也走反代，而不是让本服务直接读 sync-server/data/sync-data.json
 * =====================================================================
 * 那份 JSON 只有一个权威写者：7788 常驻内存、每次落盘整份覆盖。
 * 本服务再插一手就成了第二个写者，谁最后落盘谁赢，别人刚写的记录静默消失；而且
 * 「什么算合法记录 / 怎么按 LWW 合并 / 墓碑怎么推导」只有 sync-server 里有一份权威实现
 * （与 src/services/sync/protocol.ts 逐条对应），在第二个地方重写一份迟早漂移。
 * 反代让「读」和「写」都只发生在 7788 内，浏览器拿到的仍是同一份合并后的全量，
 * 页面上「立即同步」推上去的记录也能由 7788 继续发给手机。
 * 代价：7788 没在跑时同步不可用（回 502 与中文原因，页面提示「同步服务未启动」）。
 *
 * 安全边界（本机自用服务，默认只信回环）
 * ====================================
 *   - 只监听 127.0.0.1。HOST 显式指定非回环地址时直接拒绝启动 —— 对局域网开放必须先有
 *     口令机制，本期没有，宁可不开。
 *   - 代理路由校验 Origin：存在且 host 与本服务不同就 403，防止任意网页借 127.0.0.1
 *     白嫖你的 key；Origin 为空时放行（同源 GET / curl 本来就不带）。
 *   - 代理路由同时校验 Host 只认回环地址，挡住 DNS rebinding。
 *   - 静态文件路径解码后逐段校验，拒绝 .. / 绝对路径 / 反斜杠 / NUL，且落地路径必须
 *     落在 dist/ 内 —— 读不到 dist 之外的东西，尤其是 .secrets/。
 *   - 请求体上限 20 MB，超限 413。
 *
 * 零依赖：只用 node: 内置模块。日志写到 local-server/logs/server.log（追加，2 MB 轮转）。
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 项目根目录（local-server/ 的上一级） */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** 静态托管目录：前端构建产物 */
const DIST = path.join(ROOT, 'dist')
/** 密钥文件：单行 API key，已被 .gitignore 忽略 */
const SECRET_FILE = path.join(ROOT, '.secrets', 'api-key.txt')
/** 日志目录与文件 */
const LOG_DIR = path.join(ROOT, 'local-server', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'server.log')
/** 日志轮转阈值 */
const LOG_MAX_BYTES = 2 * 1024 * 1024

/** 上游 API 服务 */
const UPSTREAM = 'https://api.deepseek.com'
/** 同步服务（sync-server）地址：SYNC_UPSTREAM 可改，测试时指向临时端口 */
const SYNC_UPSTREAM_RAW = (process.env.SYNC_UPSTREAM ?? 'http://127.0.0.1:7788').trim()
/** 上游自签证书的 CA 文件（通常就是 sync-server/tls/cert.pem）；给了就按它校验 */
const SYNC_CA_FILE = (process.env.SYNC_CA_FILE ?? '').trim()
/** 上游证书 SHA-256 指纹（可带冒号）；给了就做固定校验（会关闭链校验，适合自签） */
const SYNC_FINGERPRINT = (process.env.SYNC_FINGERPRINT ?? '').replace(/:/g, '').trim().toLowerCase()
/** 读一次 CA；读不到直接退出，避免运行时每条同步都失败 */
const SYNC_CA_PEM = (() => {
  if (!SYNC_CA_FILE) {
    return null
  }
  try {
    return readFileSync(SYNC_CA_FILE, 'utf8')
  } catch (error) {
    process.stderr.write('读取 SYNC_CA_FILE 失败：' + SYNC_CA_FILE + '（' + error.message + '）\n')
    process.exit(1)
  }
})()
/**
 * 同步服务的访问口令文件：与 sync-server/start.ps1 -Lan 的第三个来源是同一份（.secrets 已 gitignore）。
 * 局域网模式下 7788 的所有 /api/* 都要口令，而同源反代 /sync/api/* 是浏览器唯一的通道，
 * 口令不在这里补上，页面就会整片 401。
 */
const SYNC_TOKEN_FILE = path.join(ROOT, '.secrets', 'sync-token.txt')

/**
 * 读同步口令：先 .secrets/sync-token.txt 首行，其次 SYNC_TOKEN 环境变量。
 *
 * 为什么文件优先：文件是持久化的事实来源（start.ps1 -Lan 最终也是它），环境变量可能属于
 * 父进程、与 7788 实际用的那份不一致；两者不一致时反代会全线 401，而这种错很难看出来。
 *
 * @returns {string} 口令；空串表示上游没开口令（回环模式），反代不注入
 * @sideeffect 只读文件，不打印口令
 */
const readSyncToken = () => {
  const candidates = []
  try {
    candidates.push(readFileSync(SYNC_TOKEN_FILE, 'utf8').split(/\r?\n/)[0].trim())
  } catch {
    // 文件不存在：没配口令
  }
  candidates.push((process.env.SYNC_TOKEN ?? '').trim())
  for (const value of candidates) {
    if (value && !/\s/.test(value)) {
      return value
    }
  }
  return ''
}

/** 反代给上游补的 Bearer 口令（空串 = 不注入，行为与改造前一致） */
const SYNC_PROXY_TOKEN = readSyncToken()
/**
 * 同步反代前缀：浏览器打同源 /sync/api/*，本服务把这段前缀换成上游的 /api/*。
 * 前端（src/services/sync/api.ts）把同源服务地址算成 http://127.0.0.1:<port>/sync，
 * 拼上它固定的 /api/health 正好落到这里。
 */
const SYNC_PREFIX = '/sync/api'
/** 同步请求体上限：与 sync-server 的 MAX_BODY、客户端 MAX_SYNC_BYTES 一致（32 MB） */
const MAX_SYNC_BODY_BYTES = 32 * 1024 * 1024
/** 同步上游多久没响应算失败（毫秒）：本机服务，慢成这样就是卡住了 */
const SYNC_TIMEOUT_MS = 10_000
const UPSTREAM_HOST = 'api.deepseek.com'
/** 服务标识：/api/health 返回它，前端据此确认「是本机服务」而不是别人的同名路径 */
const SERVICE_ID = 'deepseek-chat-local'
/** 默认端口；PORT 环境变量可改 */
const DEFAULT_PORT = 7789
/** 允许监听的地址：只认回环 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const DEFAULT_HOST = '127.0.0.1'
/** 请求体上限 */
const MAX_BODY_BYTES = 20 * 1024 * 1024
/** 合法的 key 形态（与 rspack.config.ts / tools/build-apk.ps1 的判定保持一致） */
const KEY_PATTERN = /^sk-[A-Za-z0-9]{16,}$/

/** 扩展名 -> Content-Type；文本类显式带 charset，避免浏览器按其它编码猜 */
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json'],
])

/** 明确不往浏览器传的响应头：cookie 会污染本机站点，逐跳头由 Node 自己管 */
const DROP_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
])

/** 只转发这些请求头；鉴权头由服务端注入，其余一律不带（也就不可能被网页塞进别的东西） */
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'user-agent',
]

/**
 * 转发给同步服务的请求头。
 * 与 /anthropic 那套不同：这里不注入任何密钥，但要原样带上口令头 —— 7788 设了
 * --token 时缺 Authorization / X-Sync-Token 会直接 401，而口令是本机页面的用户自己填的。
 * 不转发 Origin：本服务已经按同源校验过（见 proxyToSync），上游不需要再看一遍。
 */
const SYNC_FORWARD_HEADERS = [
  'accept',
  'content-type',
  'authorization',
  'x-sync-token',
  'user-agent',
]

/* ────────────────────────────── 日志 ────────────────────────────── */

/**
 * 追加一行日志（同时打 stdout，隐藏窗口下没人接也无所谓）。
 *
 * @param {string} level 级别标签，如 info / warn / error
 * @param {string} message 内容（禁止传 key 或请求体）
 * @returns {void}
 * @sideeffect 写 local-server/logs/server.log；超过 2 MB 时轮转成 server.log.1
 */
const log = (level, message) => {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + message
  process.stdout.write(line + '\n')
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        renameSync(LOG_FILE, LOG_FILE + '.1')
      }
    } catch {
      // 文件还不存在：下面直接写
    }
    appendFileSync(LOG_FILE, line + '\n')
  } catch {
    // 日志失败不能影响服务
  }
}

/* ────────────────────────────── 密钥 ────────────────────────────── */

/**
 * 读取 API key：环境变量 DS_API_KEY 优先，其次 .secrets/api-key.txt。
 * 只保留合法形态的值；日志里只说来源，绝不打 key 本身。
 *
 * @returns {{ key: string, source: string | null }} key 为空串表示未配置
 */
const readApiKey = () => {
  const fromEnv = (process.env.DS_API_KEY ?? '').trim()
  if (KEY_PATTERN.test(fromEnv)) {
    return { key: fromEnv, source: 'env' }
  }
  if (fromEnv) {
    log('warn', 'DS_API_KEY 存在但形态不像 API key（应为单行 sk- 开头的串），忽略')
  }
  try {
    const fromFile = readFileSync(SECRET_FILE, 'utf8').trim()
    if (KEY_PATTERN.test(fromFile)) {
      return { key: fromFile, source: 'file' }
    }
    log('warn', SECRET_FILE + ' 存在但内容不像 API key，忽略')
  } catch {
    // 文件不存在：未配置
  }
  return { key: '', source: null }
}

/* ────────────────────────── 静态文件 ────────────────────────── */

/**
 * 把请求路径解析成 dist/ 内的绝对路径。
 *
 * 先按 %XX 解码一次，再按 / 切段逐段拒绝 . 与 ..；反斜杠、NUL、非 / 开头（绝对 URI）
 * 一律拒绝。最后核对落地路径确实在 dist/ 内 —— 双保险，任何写法都出不去。
 *
 * @param {string} urlPath 原始路径（不含 query）
 * @returns {string | null} dist/ 内的绝对路径；非法时 null
 */
const resolveInDist = (urlPath) => {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) {
    return null
  }
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return null
  }
  for (const segment of decoded.split('/')) {
    if (segment === '.' || segment === '..') {
      return null
    }
  }
  const target = path.resolve(DIST, '.' + decoded)
  if (target !== DIST && !target.startsWith(DIST + path.sep)) {
    return null
  }
  return target
}

/**
 * 给静态响应挑缓存策略：/static/ 下是带 contenthash 的产物，可以长缓存；其它（尤其
 * index.html）必须每次回源，否则改了 dist 刷新还是旧的。
 *
 * @param {string} urlPath 请求路径
 * @returns {string} Cache-Control 头
 */
const cacheControlOf = (urlPath) =>
  urlPath.startsWith('/static/') ? 'public, max-age=31536000, immutable' : 'no-cache'

/**
 * 发一个文件：ETag 命中回 304，HEAD 只回头。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @param {string} filePath 绝对路径
 * @param {string} cacheControl Cache-Control 值
 * @returns {void}
 * @sideeffect 读磁盘、写响应
 */
const sendFile = (req, res, filePath, cacheControl) => {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    respondError(req, res, 404, 'not_found', '找不到文件')
    return
  }
  const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"'
  const headers = {
    'content-type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'cache-control': cacheControl,
    etag,
    'last-modified': stat.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['content-length'] = String(stat.size)
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(filePath)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * 静态路由：文件 -> 目录 index.html -> SPA 回落 -> 404。
 *
 * SPA 回落只对「GET/HEAD 且末段没有扩展名」生效：既让 /chat/xxx 这类前端路由拿到 index.html，
 * 又不会把不存在的 .txt / .js 请求伪装成 200（路径穿越探测因此拿到 404 而不是首页）。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @param {string} urlPath 请求路径
 * @returns {void}
 */
const serveStatic = (req, res, urlPath) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    res.end('405 Method Not Allowed')
    return
  }
  const target = resolveInDist(urlPath)
  if (target === null) {
    respondError(req, res, 400, 'bad_path', '路径非法：本机服务只托管 dist/ 内的文件')
    return
  }
  const cacheControl = cacheControlOf(urlPath)
  try {
    if (statSync(target).isDirectory()) {
      const index = path.join(target, 'index.html')
      if (existsSync(index)) {
        sendFile(req, res, index, 'no-cache')
        return
      }
    } else {
      sendFile(req, res, target, cacheControl)
      return
    }
  } catch {
    // 不存在：走下面的回落
  }
  const lastSegment = urlPath.slice(urlPath.lastIndexOf('/') + 1)
  if (!lastSegment.includes('.')) {
    const index = path.join(DIST, 'index.html')
    if (existsSync(index)) {
      sendFile(req, res, index, 'no-cache')
      return
    }
  }
  respondError(req, res, 404, 'not_found', '找不到文件：dist/ 里没有这个路径（构建产物存在吗？）')
}

/* ────────────────────────── 通用响应 ────────────────────────── */

/**
 * 回一个 JSON 错误体。
 *
 * 形状刻意与上游一致（{ error: { type, message } }）：前端的错误处理读的就是
 * error.message，走代理与直连时表现一致。type 让前端能识别「本机服务自己的问题」
 * （目前只有 local_service_no_key）。
 *
 * @param {import('node:http').IncomingMessage} req 请求（只用于记日志）
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status HTTP 状态码
 * @param {string} type 错误类型
 * @param {string} message 中文说明
 * @returns {void}
 */
const respondError = (req, res, status, type, message) => {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ error: { type, message } })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * 回 413（请求体超限）。
 *
 * 必须先把响应完整写出去，再去收拾上游与客户端连接：先 destroy 会让 413 还没冲刷就
 * 被拆掉 socket，客户端只会看到超时或空响应。带 Connection: close 是因为请求体没读完，
 * 这条连接无法复用。
 *
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} limitBytes 上限字节数（提示文案按它换算成 MB）
 * @returns {void}
 */
const respondTooLarge = (res, limitBytes = MAX_BODY_BYTES) => {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({
    error: {
      type: 'body_too_large',
      message: '请求体超过上限（' + Math.round(limitBytes / 1024 / 1024) + ' MB）',
    },
  })
  res.writeHead(413, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    connection: 'close',
  })
  res.end(body)
}

/**
 * 判断 Origin 是否与本服务同源。
 *
 * @param {string | undefined} origin 请求的 Origin 头
 * @param {string | undefined} host 请求的 Host 头
 * @returns {boolean} 同源（或没有 Origin）为 true；不透明源（"null"）为 false
 */
const isSameOrigin = (origin, host) => {
  if (!origin) {
    return true
  }
  try {
    const parsed = new URL(origin)
    return typeof host === 'string' && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Host 头是否指向回环地址（含端口写法）。
 *
 * @param {string | undefined} host Host 头
 * @returns {boolean} 是回环地址为 true
 */
const isLoopbackAuthority = (host) => {
  if (typeof host !== 'string' || !host) {
    return false
  }
  const value = host.toLowerCase()
  const name = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : value.slice(0, value.includes(':') ? value.indexOf(':') : value.length)
  return LOOPBACK_HOSTS.has(name)
}

/* ────────────────────────── 反向代理 ────────────────────────── */

/**
 * 代理一条请求到上游。
 *
 * 流式（SSE）是这里的头等需求：响应边收边写，不缓存也不改 chunk。向上游要 identity 编码
 * （gzip 会把 SSE 攒成块，看着像卡住），并且不设缓冲。
 *
 * 请求体则是「先读完、判完体积、再打上游」：边读边转发过一版，实测会输给上游——
 * 21 MB 的 chunked body 刚转出去一部分，上游就因为内容非法把连接 RST 了，我们这边的
 * 字节计数还没到上限，于是客户端拿到的是 502 或者干脆挂到超时，而不是明确的 413。
 * 代价是请求体在内存里待一份（上限 20 MB，本机单用户服务可接受），响应流式不受影响。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @param {string} upstreamPath 上游路径（含 query）
 * @param {{ key: string, source: string | null }} apiKey 服务端持有的 key
 * @returns {void}
 */
const proxyToUpstream = (req, res, upstreamPath, apiKey) => {
  const started = Date.now()
  const origin = req.headers.origin
  if (!isSameOrigin(origin, req.headers.host)) {
    log('warn', '403 跨站请求被拒绝：' + req.method + ' ' + upstreamPath + ' Origin=' + String(origin))
    respondError(req, res, 403, 'cross_origin', '拒绝跨站请求：代理路由只服务本机页面（Origin 与本服务不同源）')
    return
  }
  if (!isLoopbackAuthority(req.headers.host)) {
    log('warn', '403 非回环 Host 被拒绝：' + String(req.headers.host) + ' ' + upstreamPath)
    respondError(req, res, 403, 'bad_host', '拒绝非回环 Host 的请求：代理路由只接受 127.0.0.1 / localhost')
    return
  }
  if (!apiKey.key) {
    respondError(
      req,
      res,
      503,
      'local_service_no_key',
      '本机服务还没有配置 API key：把 key 写进 .secrets\\api-key.txt，或设置环境变量 DS_API_KEY，然后重启本机服务（local-server\\stop.ps1 + start.ps1）。'
    )
    return
  }
  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    log('warn', '413 请求体超限（Content-Length）' + req.method + ' ' + upstreamPath)
    respondTooLarge(res)
    // 把剩下的请求体读掉丢掉：curl 才收得到完整的 413，而不是被拆连接
    req.resume()
    return
  }

  const headers = { 'accept-encoding': 'identity', 'x-api-key': apiKey.key }
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) {
      headers[name] = value
    }
  }

  /**
   * 请求体读完且体积合规后，真正打上游。
   *
   * @param {Buffer} body 已读到的请求体（GET 这类无 body 的请求是空 Buffer）
   * @returns {void}
   */
  const sendToUpstream = (body) => {
    const upstreamReq = httpsRequest(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        method: req.method,
        path: upstreamPath,
        headers: { ...headers, 'content-length': String(body.length) },
      },
      (upstreamRes) => {
        const responseHeaders = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined && !DROP_RESPONSE_HEADERS.has(name)) {
            responseHeaders[name] = value
          }
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
        // SSE 必须立刻把响应头送出去，否则浏览器要等第一个数据块才开始读
        res.flushHeaders()
        res.socket?.setNoDelay(true)
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
        res.on('close', () => upstreamRes.destroy())
        log(
          'info',
          req.method + ' ' + upstreamPath + ' -> ' + String(upstreamRes.statusCode) + ' (' + (Date.now() - started) + 'ms)'
        )
      }
    )

    upstreamReq.on('error', (error) => {
      log('error', '上游请求失败 ' + req.method + ' ' + upstreamPath + '：' + error.message)
      if (!res.headersSent) {
        respondError(req, res, 502, 'upstream_unreachable', '上游 API 连不上：' + error.message)
      } else {
        res.destroy()
      }
    })

    // 客户端先断开（停止生成）时连带掐掉上游，别让它继续烧 token
    res.on('close', () => upstreamReq.destroy())
    upstreamReq.end(body)
  }

  /** 已收到的请求体分片；读完再拼，体积判定因此先于任何上游动作 */
  const chunks = []
  let received = 0
  let rejected = false

  /**
   * 边读边累计到超过上限时的处理。
   *
   * 顺序很关键：先把 413 完整写出去（respondTooLarge 内部 writeHead + end），再摘掉监听、
   * 把剩余请求体读掉丢掉。反过来先 destroy 客户端 socket，413 还没冲刷就被拆掉 ——
   * 实测症状是 curl 收到 100 后一路等到超时，或者拿到半截响应。
   *
   * @returns {void}
   */
  function rejectOversize() {
    rejected = true
    log('warn', '413 请求体超限（chunked）' + req.method + ' ' + upstreamPath)
    respondTooLarge(res)
    req.removeListener('data', onData)
    req.removeListener('end', onEnd)
    req.resume()
  }

  /**
   * 收请求体并做体积统计。
   *
   * @param {Buffer} chunk 数据块
   * @returns {void}
   */
  function onData(chunk) {
    if (rejected) {
      return
    }
    received += chunk.length
    if (received > MAX_BODY_BYTES) {
      rejectOversize()
      return
    }
    chunks.push(chunk)
  }

  /**
   * 请求体收完：体积合规才打上游。
   *
   * @returns {void}
   */
  function onEnd() {
    if (!rejected) {
      sendToUpstream(Buffer.concat(chunks, received))
    }
  }

  req.on('data', onData)
  req.on('end', onEnd)
}

/* ──────────────────────── 同步服务反代 ──────────────────────── */

/**
 * 同步服务连不上（进程没起来 / 端口不对 / 卡死）时的响应。
 *
 * 502 + 结构化中文原因：前端按 error.type 认出「同步服务未启动」，显示一句能照着做的话，
 * 而不是把这段 JSON 当裸错误拼到界面里。这也是本服务与 sync-server 的刻意差异：
 * sync-server 自己的错误体是 { ok, error: string }，这里是 { error: { type, message } }，
 * 与 /anthropic 那套错误体一致，前端一处解析两处通用。
 *
 * @param {import('node:http').ServerResponse} res 响应
 * @param {string} type 错误类型（sync_upstream_down / sync_upstream_timeout）
 * @param {string} message 中文说明（含怎么修）
 * @returns {void}
 */
const respondSyncDown = (res, type, message) => {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ ok: false, error: { type, message } })
  res.writeHead(502, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 把 /sync/api/* 反代到同步服务（sync-server）的 /api/*。
 *
 * 与 proxyToUpstream 的差别：不注入任何密钥（同步口令由页面自己带），请求体上限按
 * 32 MB（与 sync-server / 客户端一致），上游是本机明文 HTTP，没有 SSE 那种流式需求，
 * 但响应照样边收边写，免得整份全量在内存里再拼一遍。
 *
 * 安全：沿用 /anthropic 的两道闸（Origin 同源、Host 只认回环）。这两道不是可选的 ——
 * 本服务转给上游时不带 Origin，sync-server 会把「没有 Origin」当成 curl 一样放行，
 * 少了这道闸，任意网页就能借 127.0.0.1:7789 读写这台机器的全部会话。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @param {string} upstreamPath 上游路径（形如 /api/state，含 query）
 * @returns {void}
 */
const proxyToSync = (req, res, upstreamPath) => {
  const started = Date.now()
  const origin = req.headers.origin
  if (!isSameOrigin(origin, req.headers.host)) {
    log('warn', '403 跨站同步请求被拒绝：' + req.method + ' ' + upstreamPath + ' Origin=' + String(origin))
    respondError(req, res, 403, 'cross_origin', '拒绝跨站请求：同步反代只服务本机页面（Origin 与本服务不同源）')
    return
  }
  if (!isLoopbackAuthority(req.headers.host)) {
    log('warn', '403 非回环 Host 被拒绝：' + String(req.headers.host) + ' ' + upstreamPath)
    respondError(req, res, 403, 'bad_host', '拒绝非回环 Host 的请求：同步反代只接受 127.0.0.1 / localhost')
    return
  }
  if (!syncUpstream) {
    respondSyncDown(res, 'sync_upstream_down', '同步服务未启动：本服务没有可用的同步上游地址')
    return
  }
  // 路径里出现 .. 一律不接：反代只映射 /sync/api/<x> → /api/<x>，不需要任何目录语义
  if (upstreamPath.includes('..')) {
    respondError(req, res, 400, 'bad_path', '路径非法：同步反代不接受 .. 段')
    return
  }

  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SYNC_BODY_BYTES) {
    log('warn', '413 同步请求体超限（Content-Length）' + req.method + ' ' + upstreamPath)
    respondTooLarge(res, MAX_SYNC_BODY_BYTES)
    req.resume()
    return
  }

  const headers = {}
  for (const name of SYNC_FORWARD_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) {
      headers[name] = value
    }
  }
  // 局域网模式下 7788 的 /api/* 一律要口令，而页面这边只会带设备令牌（甚至什么都不带）：
  // 命令行走 /sync/api/* 的请求在这里补一个 Bearer，页面零改动。
  // 请求自己带了 Authorization / X-Sync-Token 时不动它 —— 设备令牌优先，别用主口令盖掉。
  if (SYNC_PROXY_TOKEN && !headers.authorization && !headers['x-sync-token']) {
    headers.authorization = 'Bearer ' + SYNC_PROXY_TOKEN
  }

  /**
   * 请求体读完后打上游，响应边收边写。
   *
   * @param {Buffer} body 请求体
   * @returns {void}
   */
  const sendToSync = (body) => {
    const requestModule = syncUpstream.protocol === 'https:' ? httpsRequest : httpRequest
    const options = {
      protocol: syncUpstream.protocol,
      hostname: syncUpstream.hostname,
      port: syncUpstream.port,
      method: req.method,
      path: upstreamPath,
      headers: { ...headers, 'content-length': String(body.length) },
      timeout: SYNC_TIMEOUT_MS,
    }
    if (syncUpstream.protocol === 'https:') {
      // 自签证书两种校验方式：CA 文件（推荐，链校验仍然开启）或精确指纹
      if (SYNC_CA_PEM) {
        options.ca = SYNC_CA_PEM
      }
      if (SYNC_FINGERPRINT) {
        options.rejectUnauthorized = false
        options.checkServerIdentity = (_host, cert) => {
          const actual = String(cert?.fingerprint256 ?? '')
            .replace(/:/g, '')
            .toLowerCase()
          return actual === SYNC_FINGERPRINT
            ? undefined
            : new Error('同步服务证书指纹不匹配')
        }
      }
    }
    const upstreamReq = requestModule(
      options,
      (upstreamRes) => {
        const responseHeaders = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined && !DROP_RESPONSE_HEADERS.has(name)) {
            responseHeaders[name] = value
          }
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
        res.flushHeaders()
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
        res.on('close', () => upstreamRes.destroy())
        log(
          'info',
          req.method + ' ' + upstreamPath + ' -> ' + String(upstreamRes.statusCode) + ' (' + (Date.now() - started) + 'ms)'
        )
      }
    )

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('上游 ' + SYNC_TIMEOUT_MS + 'ms 无响应'))
    })
    upstreamReq.on('error', (error) => {
      const timedOut = error.code === undefined || error.code === 'ETIMEDOUT'
      log('warn', '同步上游不可用 ' + req.method + ' ' + upstreamPath + '：' + error.message)
      respondSyncDown(
        res,
        timedOut ? 'sync_upstream_timeout' : 'sync_upstream_down',
        timedOut
          ? '同步服务没有响应：' + syncUpstream.origin + ' ' + Math.round(SYNC_TIMEOUT_MS / 1000) + ' 秒内没回话，看看端口 ' + syncUpstream.port + ' 上的进程是不是卡住了'
          : '同步服务未启动：' + syncUpstream.origin + ' 连不上（' + String(error.code) + '）。先运行 node sync-server\\server.mjs --port ' + syncUpstream.port + '，再点「立即同步」。'
      )
      upstreamReq.destroy()
    })
    res.on('close', () => upstreamReq.destroy())
    upstreamReq.end(body)
  }

  /** 已收到的请求体分片；读完再打上游，体积判定因此先于任何上游动作 */
  const chunks = []
  let received = 0
  let rejected = false

  /**
   * 边读边累计超过上限的处理：先完整回 413，再把剩余请求体读掉丢掉。
   *
   * @returns {void}
   */
  function rejectOversize() {
    rejected = true
    log('warn', '413 同步请求体超限（chunked）' + req.method + ' ' + upstreamPath)
    respondTooLarge(res, MAX_SYNC_BODY_BYTES)
    req.removeListener('data', onData)
    req.removeListener('end', onEnd)
    req.resume()
  }

  /**
   * 收请求体并做体积统计。
   *
   * @param {Buffer} chunk 数据块
   * @returns {void}
   */
  function onData(chunk) {
    if (rejected) {
      return
    }
    received += chunk.length
    if (received > MAX_SYNC_BODY_BYTES) {
      rejectOversize()
      return
    }
    chunks.push(chunk)
  }

  /**
   * 请求体收完：体积合规才打上游。
   *
   * @returns {void}
   */
  function onEnd() {
    if (!rejected) {
      sendToSync(Buffer.concat(chunks, received))
    }
  }

  req.on('data', onData)
  req.on('end', onEnd)
}

/* ────────────────────────── 健康检查 ────────────────────────── */

/**
 * 统计 dist 的现状：构建产物有没有、里面有没有把真实 key 烘进去。
 *
 * 「产物里带 key」不影响本服务（它本来就不读前端产物里的 key），但意味着这份 dist 是给
 * APK 用的那种构建，把它当网页产物托管等于把 key 发给每个访问者 —— 启动时提示一句。
 *
 * @param {string} apiKey 服务端 key；空串时这个检查没有意义
 * @returns {{ distReady: boolean, distHasBakedKey: boolean }} 只给布尔，不回显 key
 */
const inspectDist = (apiKey) => {
  const distReady = existsSync(path.join(DIST, 'index.html'))
  if (!distReady || !apiKey) {
    return { distReady, distHasBakedKey: false }
  }
  let hasKey = false
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (hasKey) {
        return
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.js')) {
        try {
          if (readFileSync(full, 'utf8').includes(apiKey)) {
            hasKey = true
          }
        } catch {
          // 读不了就跳过
        }
      }
    }
  }
  walk(DIST)
  return { distReady, distHasBakedKey: hasKey }
}

/* ────────────────────────── 启动 ────────────────────────── */

const apiKey = readApiKey()
const port = (() => {
  const raw = process.env.PORT
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    process.stderr.write('PORT 不合法（应为 1-65535 的整数）：' + raw + '\n')
    process.exit(1)
  }
  return parsed
})()
const host = process.env.HOST ?? DEFAULT_HOST
if (!LOOPBACK_HOSTS.has(host)) {
  process.stderr.write(
    '拒绝启动：HOST=' + host + ' 不是回环地址。\n' +
      '本机服务把服务端的 API key 借给页面用，对局域网开放等于把 key 交给同网段的任何设备；\n' +
      '要这么用必须先有口令/鉴权机制，本期没有实现。去掉 HOST 环境变量即可（默认只监听 127.0.0.1）。\n'
  )
  process.exit(1)
}

/**
 * 解析同步上游（sync-server）地址：只接受回环地址上的 http(s)。
 *
 * 为什么限定回环：这个反代把浏览器的同步请求（可能带同步口令）原样转给上游，
 * 指到局域网/公网地址就等于把本机同步数据的一条通道借出去。要连别的机器上的同步服务，
 * 直接在设置里手填那台机器的地址（那条路径不经过本服务）。
 *
 * @returns {{ protocol: string, hostname: string, port: number, origin: string }} 已归一的上游
 * @sideeffect 地址非法时打印中文原因并 process.exit(1)
 */
const syncUpstream = (() => {
  let parsed = null
  try {
    parsed = new URL(SYNC_UPSTREAM_RAW)
  } catch {
    parsed = null
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    process.stderr.write('SYNC_UPSTREAM 不是合法的 http(s) 地址：' + SYNC_UPSTREAM_RAW + '\n')
    process.exit(1)
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    process.stderr.write(
      '拒绝启动：SYNC_UPSTREAM=' + SYNC_UPSTREAM_RAW + ' 不是回环地址。\n' +
        '同步反代把浏览器的请求（可能带同步口令）原样转给上游，对局域网/公网开放等于把本机\n' +
        '同步数据借给同网段的任何设备。去掉 SYNC_UPSTREAM 即默认 http://127.0.0.1:7788。\n'
    )
    process.exit(1)
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return { protocol: parsed.protocol, hostname: parsed.hostname, port, origin: parsed.origin }
})()

const { distReady, distHasBakedKey } = inspectDist(apiKey.key)
const startedAt = Date.now()

/**
 * GET /api/health：给启停脚本与前端探测用。key 只以布尔出现，任何字段都不含 key 本身。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {void}
 */
const serveHealth = (req, res) => {
  const body = JSON.stringify(
    {
      ok: true,
      service: SERVICE_ID,
      pid: process.pid,
      port,
      upstream: UPSTREAM,
      keyConfigured: Boolean(apiKey.key),
      keySource: apiKey.source,
      distReady,
      distHasBakedKey,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
    },
    null,
    2
  )
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

const server = createServer((req, res) => {
  const rawUrl = req.url ?? '/'
  const queryIndex = rawUrl.indexOf('?')
  const urlPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
  const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex)

  if (urlPath === '/api/health') {
    serveHealth(req, res)
    return
  }
  if (urlPath === '/anthropic' || urlPath.startsWith('/anthropic/')) {
    proxyToUpstream(req, res, urlPath + search, apiKey)
    return
  }
  if (urlPath === '/models') {
    proxyToUpstream(req, res, '/models' + search, apiKey)
    return
  }
  // 同源同步路由：/sync/api/state -> 同步服务的 /api/state（前缀整段换掉，其余原样）
  if (urlPath === SYNC_PREFIX || urlPath.startsWith(SYNC_PREFIX + '/')) {
    proxyToSync(req, res, '/api' + urlPath.slice(SYNC_PREFIX.length) + search)
    return
  }
  // 浏览器会无条件请求 /favicon.ico：dist 里没有就回 204，别在控制台留一条红的 404
  if (urlPath === '/favicon.ico' && !existsSync(path.join(DIST, 'favicon.ico'))) {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' })
    res.end()
    return
  }
  serveStatic(req, res, urlPath)
})

server.on('clientError', (error, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  }
  log('warn', '客户端错误：' + error.message)
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('error', '端口 ' + port + ' 已被占用：先运行 local-server\\stop.ps1，或换一个 PORT')
    process.exit(2)
  }
  log('error', '服务错误：' + error.message)
  process.exit(1)
})

server.listen(port, host, () => {
  log('info', '本机服务已启动：http://' + host + ':' + port + '（上游 ' + UPSTREAM + '）')
  log('info', '同步反代 ' + SYNC_PREFIX + '/* → ' + syncUpstream.origin + '/api/*')
  log(
    'info',
    SYNC_PROXY_TOKEN
      ? '同步反代鉴权：已加载口令（缺鉴权头的请求自动补 Bearer；口令本身不打印）'
      : '同步反代鉴权：未配口令（上游按回环无口令运行）'
  )
  if (syncUpstream.protocol === 'https:') {
    log(
      'info',
      '同步上游 TLS：' +
        (SYNC_FINGERPRINT ? '指纹固定' : SYNC_CA_PEM ? 'CA 文件校验' : '系统信任链')
    )
  }
  log('info', '静态目录 ' + DIST + '（' + (distReady ? '就绪' : '缺少 index.html：先跑 pnpm build:web') + '）')
  log(
    'info',
    apiKey.key ? '已加载 API key（来源：' + apiKey.source + '）' : '未配置 API key：静态页面可用，代理路由返回 503'
  )
  if (distHasBakedKey) {
    log('warn', 'dist/ 里含明文 API key（那是 APK 用的构建）；网页产物请用 pnpm build:web 重新构建')
  }
})

/**
 * 关停：给在途请求一点时间，然后退出。
 *
 * @param {string} signal 信号名
 * @returns {void}
 */
const shutdown = (signal) => {
  log('info', '收到 ' + signal + '，正在关闭')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (error) => {
  log('error', '未捕获异常：' + (error && error.stack ? error.stack : String(error)))
})
process.on('unhandledRejection', (reason) => {
  log('error', '未处理的 Promise 拒绝：' + String(reason))
})
