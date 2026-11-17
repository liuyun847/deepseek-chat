/**
 * 单机双端模拟的「一台设备」。
 *
 * 目的：在没有第二台手机的条件下，把局域网直连的四条链路真跑一遍 ——
 *   1. 发现：UDP 广播 + 对端表（与 Java 侧 LanLink 同一份信封格式）
 *   2. 配对：pairTag（口令派生密钥的指纹）比对；不匹配就不同步
 *   3. 加密：PBKDF2 + AES-GCM 封包/解包（复用 src/services/sync/lan/crypto.ts 原文件）
 *   4. 合并：planTransfer / planClientApply（复用 src/services/sync/lan/transfer.ts）
 *
 * 与真机的差别（报告里也写明了）：传输层用 Node 的 dgram/net 重写了一遍，
 * 而业务与加密代码是同一份 .ts 编译产物，所以验证的是协议与算法，不是 Java 代码本身。
 * Java 那一层由「模拟器 + 主机上的 Node 对端」那次联调覆盖（见 interop.mjs）。
 *
 * 用法：
 *   node peer.mjs --id dev-a --name 手机A --pass 12345678 --seed a
 *   node peer.mjs --id dev-e2e --name 手机E2E --pass <口令> --udp-port 47823 --seed e2e
 *     （e2e = 只有 1 个会话「端到端验收 2026-11-17」+ 1 条消息，用于验收链路；
 *      live = 只有 1 个会话「不重启可见 2026-11-17」+ 1 条消息，用于验证外部写入免重启）
 *   stdin 命令：stats / dump / edit <sessionId> <text> / delete-session <id> / probe <host:port> / quit
 */
import dgram from 'node:dgram'
import net from 'node:net'
import readline from 'node:readline'

import { deriveKeyBytes, importLanKey, openMessage, pairTagOf, sealMessage } from './build/src/services/sync/lan/crypto.js'
import { buildLocalRecords, applyPulledRecords, recordsToSnapshots } from './build/src/services/sync/merge.js'
import {
  LAN_FORMAT,
  LAN_PROTO,
  createRequestId,
  envelopeAad,
  parseEnvelope,
  parseMessage,
  stampOf,
  statsOf,
} from './build/src/services/sync/lan/protocol.js'
import { planClientApply, planTransfer } from './build/src/services/sync/lan/transfer.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const device = argOf('id', 'dev-a')
const name = argOf('name', '手机A')
const passphrase = argOf('pass', '12345678')
const seed = argOf('seed', '')
const discoverPort = Number(argOf('udp-port', '47824'))
const announceMs = Number(argOf('announce-ms', '1000'))
/** 固定 TCP 端口（与真机联调时用，方便 adb forward / 直连）；0 表示随机 */
const fixedTcpPort = Number(argOf('tcp-port', '0'))
/** 额外的单播广播目标 host:port，逗号分隔（模拟器 NAT 下收不到 255.255.255.255 时用） */
const extraTargets = argOf('announce-extra', '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item.length > 0)
const maxBytes = 32 * 1024 * 1024

const log = (message) => process.stdout.write('## ' + message + '\n')
const prefix = (message) => '[' + device + '] ' + message

/** 本地「数据库」：会话列表 + 同步记账，与页面侧 IndexedDB 的两张表一一对应 */
const store = { sessions: [], snapshots: new Map() }

const records = () =>
  buildLocalRecords({
    sessions: store.sessions,
    snapshots: store.snapshots,
    device,
    now: Date.now(),
  }).records

const saveSnapshotsFrom = (map) => {
  const next = new Map()
  for (const snapshot of recordsToSnapshots(map.values())) {
    next.set(snapshot.key, snapshot)
  }
  store.snapshots = next
}

const applyDown = (pulled) => {
  const applied = applyPulledRecords(store.sessions, pulled)
  for (const session of applied.upserts) {
    const index = store.sessions.findIndex((item) => item.id === session.id)
    if (index >= 0) {
      store.sessions[index] = session
    } else {
      store.sessions.push(session)
    }
  }
  for (const id of applied.removed) {
    store.sessions = store.sessions.filter((item) => item.id !== id)
  }
  return applied.upserts.length + applied.removed.length
}

// ── 种子数据 ────────────────────────────────────────────────────────────────

const message = (id, role, content, createdAt) => ({ id, role, content, createdAt, files: [] })

if (seed === 'a') {
  store.sessions = [
    {
      id: 's1',
      title: '共享会话',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [message('m1', 'user', '来自 A 的消息', 1100)],
    },
    {
      id: 's2',
      title: '只有 A 有',
      createdAt: 1001,
      updatedAt: 2001,
      messages: [message('m2', 'assistant', 'A 独占会话里的回复', 1300)],
    },
  ]
} else if (seed === 'b') {
  store.sessions = [
    {
      id: 's1',
      title: '共享会话（B 改过）',
      createdAt: 1000,
      updatedAt: 1500,
      messages: [message('m3', 'assistant', '来自 B 的消息', 1200)],
    },
    {
      id: 's3',
      title: '只有 B 有',
      createdAt: 1002,
      updatedAt: 2002,
      messages: [message('m4', 'user', 'B 独占会话里的提问', 1400)],
    },
  ]
} else if (seed === 'c') {
  store.sessions = [
    {
      id: 's9',
      title: 'C 的口令不同',
      createdAt: 1003,
      updatedAt: 2003,
      messages: [message('m9', 'user', '不该同步出去的私货', 1500)],
    },
  ]
} else if (seed === 'e2e') {
  // 端到端验收用：正好 1 个会话 + 1 条消息，标题能一眼看出是谁造的
  // （跑完留在正式数据里也不碍事，它是真同步产生的记录）
  const now = Date.now()
  store.sessions = [
    {
      id: 'e2e-20261117',
      title: '端到端验收 2026-11-17',
      createdAt: now - 60000,
      updatedAt: now - 30000,
      messages: [message('e2e-20261117-m1', 'user', '这条消息由 lan-sim 手机端经 P2P 推来', now - 45000)],
    },
  ]
} else if (seed === 'live') {
  // 「数据文件被外部更新后不重启 sync-server 也能看到」验收用：新 id、新标题，不碰已有记录
  const now = Date.now()
  store.sessions = [
    {
      id: 'live-20261117',
      title: '不重启可见 2026-11-17',
      createdAt: now - 60000,
      updatedAt: now - 30000,
      messages: [message('live-20261117-m1', 'user', '这条消息推到 lan-peer 之后，7788 不重启就该读得到', now - 45000)],
    },
  ]
}

// ── 密钥 ────────────────────────────────────────────────────────────────────

const keyBytes = await deriveKeyBytes(passphrase)
const key = await importLanKey(keyBytes)
const pairTag = await pairTagOf(keyBytes)

// ── 对端表 ──────────────────────────────────────────────────────────────────

/** deviceId → { deviceId, name, host, port, pairTag, lastSeen, syncing } */
const peers = new Map()
/** 已经同步过的对端 stamp，用于「远端没变就不重复拉」 */
const seenIds = new Set()

const announcePayload = () =>
  JSON.stringify({
    format: LAN_FORMAT,
    proto: LAN_PROTO,
    deviceId: device,
    name,
    port: tcpPort,
    pairTag,
  })

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
let tcpPort = 0

udp.on('error', (error) => log('udp-error ' + error.message))
udp.on('message', (buffer, rinfo) => {
  let announce = null
  try {
    announce = JSON.parse(buffer.toString('utf8'))
  } catch {
    return
  }
  if (!announce || announce.format !== LAN_FORMAT || announce.proto !== LAN_PROTO) {
    return
  }
  if (announce.deviceId === device) {
    return
  }
  const previous = peers.get(announce.deviceId)
  const paired = typeof announce.pairTag === 'string' && announce.pairTag === pairTag
  // 原地更新而不是换新对象：lastAutoSync / syncing 这些节流状态必须跨广播保留
  const peer = previous ?? { deviceId: announce.deviceId, syncing: false, lastAutoSync: 0 }
  peer.name = announce.name
  peer.host = rinfo.address
  peer.port = announce.port
  peer.pairTag = announce.pairTag
  peer.paired = paired
  peer.lastSeen = Date.now()
  peers.set(peer.deviceId, peer)
  if (!previous || previous.port !== peer.port || previous.paired !== peer.paired) {
    log(
      'peer device=' + peer.deviceId + ' host=' + peer.host + ' port=' + peer.port +
        ' paired=' + (peer.paired ? 'yes' : 'no') + ' pairTag=' + (peer.pairTag ?? '-')
    )
  }
  maybeSync(peer)
})

/** 只有 deviceId 小的一方发起同步，避免两端同时打起来 */
const mayInitiate = (peer) => device < peer.deviceId

/** 自动同步的最小间隔：广播每秒一次，不节流会每秒打一轮（真机上也是同一套节流） */
const AUTO_SYNC_INTERVAL_MS = 3000

const timers = new Map()
const scheduleSync = (peer, delayMs, force) => {
  if (!mayInitiate(peer) || !peer.paired) {
    return
  }
  if (!force && Date.now() - (peer.lastAutoSync ?? 0) < AUTO_SYNC_INTERVAL_MS) {
    return
  }
  if (timers.has(peer.deviceId)) {
    return
  }
  timers.set(
    peer.deviceId,
    setTimeout(() => {
      timers.delete(peer.deviceId)
      peer.lastAutoSync = Date.now()
      void initiateSync(peer.deviceId)
    }, delayMs)
  )
}

const maybeSync = (peer) => {
  if (!peer.paired) {
    return
  }
  scheduleSync(peer, 300, false)
}

// ── TCP 传输 ────────────────────────────────────────────────────────────────

const sealEnvelope = async (messageBody) => {
  const id = createRequestId()
  const ts = Date.now()
  const aad = envelopeAad({ from: device, id, ts })
  const sealed = await sealMessage(key, aad, messageBody)
  return JSON.stringify({ format: LAN_FORMAT, proto: LAN_PROTO, from: device, id, ts, iv: sealed.iv, data: sealed.data })
}

const openEnvelope = async (text) => {
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'format' }
  }
  const envelope = parseEnvelope(parsed, Date.now())
  if (!envelope) {
    return { error: 'format' }
  }
  if (envelope.from !== device && seenIds.has(envelope.id)) {
    return { error: 'replay' }
  }
  seenIds.add(envelope.id)
  try {
    const messageBody = await openMessage(key, envelopeAad(envelope), {
      iv: envelope.iv,
      data: envelope.data,
    })
    return { envelope, message: parseMessage(messageBody) }
  } catch (error) {
    return { envelope, error: error.code ?? 'format' }
  }
}

const serve = async (text) => {
  const opened = await openEnvelope(text)
  if (opened.error) {
    log('reject ' + opened.error + (opened.envelope ? ' from=' + opened.envelope.from : ''))
    return null
  }
  const incoming = opened.message
  if (!incoming) {
    log('reject unknown-message from=' + opened.envelope.from)
    return null
  }
  if (incoming.t === 'ping') {
    return sealEnvelope({ t: 'ping', device, name })
  }
  if (incoming.t === 'hello') {
    const local = records()
    return sealEnvelope({
      t: 'hello',
      device,
      name,
      stamp: stampOf(local.values()),
      stats: statsOf(local.values()),
    })
  }
  if (incoming.t === 'sync') {
    const local = records()
    const plan = planTransfer(local, incoming.records)
    const appliedCount = applyDown(plan.apply)
    saveSnapshotsFrom(plan.merged)
    log(
      'served from=' + opened.envelope.from + ' received=' + plan.received +
        ' applied=' + appliedCount + ' reply=' + plan.reply.length
    )
    return sealEnvelope({
      t: 'sync-reply',
      device,
      name,
      records: plan.reply,
      received: plan.received,
      applied: appliedCount,
    })
  }
  return null
}

// allowHalfOpen 必须开：请求方 write 完就 end()（半关），若按默认行为在收到 FIN 时自动关掉
// 写端，服务端就再也发不出响应了 —— 现象正是「对端没有响应」。
/** 组帧：4 字节大端长度 + UTF-8 正文（与 Java 侧 LanLink.readFrame/writeFrame 一致） */
const frameOf = (text) => {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

/** 收一帧：先凑满 4 字节头，再照长度收正文 */
const readFrame = (socket) =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let expected = -1
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (expected < 0 && buffer.length >= 4) {
        expected = buffer.readUInt32BE(0)
        buffer = buffer.subarray(4)
        if (expected > maxBytes) {
          socket.off('data', onData)
          socket.destroy(new Error('帧过大'))
          return
        }
      }
      if (expected >= 0 && buffer.length >= expected) {
        socket.off('data', onData)
        resolve(buffer.subarray(0, expected).toString('utf8'))
      }
    }
    socket.on('data', onData)
    socket.on('end', () => reject(new Error('对端在发完整帧之前关闭了连接')))
    socket.on('error', reject)
  })

const server = net.createServer((socket) => {
  socket.on('error', () => undefined)
  readFrame(socket)
    .then(async (text) => {
      const reply = await serve(text)
      if (reply) {
        socket.write(frameOf(reply), () => socket.end())
      } else {
        socket.end()
      }
    })
    .catch((error) => {
      log('serve-error ' + error.message)
      socket.destroy()
    })
})

const sendRequest = (host, port, payload) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => socket.write(frameOf(payload)))
    socket.setTimeout(15000, () => socket.destroy(new Error('请求超时')))
    socket.on('error', (error) => reject(error))
    readFrame(socket)
      .then((text) => {
        socket.end()
        resolve(text)
      })
      .catch(reject)
  })

const exchange = async (host, port, messageBody) => {
  const payload = await sealEnvelope(messageBody)
  const text = await sendRequest(host, port, payload)
  if (!text) {
    throw new Error('对端没有响应')
  }
  const opened = await openEnvelope(text)
  if (opened.error) {
    throw new Error('响应解不开：' + opened.error)
  }
  return opened.message
}

/** 完整一轮：hello 比版本 → 有差异才发记录 → 落地对方回的差异 */
const syncWith = async (host, port, label) => {
  const local = records()
  const stampBefore = stampOf(local.values())
  const hello = await exchange(host, port, {
    t: 'hello',
    device,
    name,
    stamp: stampBefore,
    stats: statsOf(local.values()),
  })
  if (!hello || hello.t !== 'hello') {
    throw new Error('hello 响应异常')
  }
  if (hello.stamp === stampBefore) {
    log('synced ' + label + ' skipped=stamp-equal')
    return { skipped: true }
  }
  const reply = await exchange(host, port, {
    t: 'sync',
    device,
    name,
    records: [...local.values()],
  })
  if (!reply || reply.t !== 'sync-reply') {
    throw new Error('sync 响应异常')
  }
  const plan = planClientApply(local, reply.records)
  const applied = applyDown(plan.pulled)
  saveSnapshotsFrom(plan.merged)
  log(
    'synced ' + label + ' pushed=' + local.size + ' got=' + reply.records.length +
      ' applied=' + applied + ' stamp=' + stampOf(records().values()).slice(0, 8)
  )
  return { skipped: false, applied }
}

const initiateSync = async (peerId) => {
  const peer = peers.get(peerId)
  if (!peer || peer.syncing) {
    return
  }
  peer.syncing = true
  try {
    await syncWith(peer.host, peer.port, 'peer=' + peer.deviceId)
  } catch (error) {
    log('sync-fail peer=' + peer.deviceId + ' ' + error.message)
  } finally {
    peer.syncing = false
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────

server.listen(fixedTcpPort, '0.0.0.0', () => {
  tcpPort = server.address().port
  udp.bind(discoverPort, '0.0.0.0', () => {
    udp.setBroadcast(true)
    log('ready device=' + device + ' tcp=' + tcpPort + ' udp=' + discoverPort + ' pairTag=' + pairTag)
    const announce = () => {
      const payload = Buffer.from(announcePayload())
      udp.send(payload, discoverPort, '255.255.255.255', () => undefined)
      for (const target of extraTargets) {
        const split = target.lastIndexOf(':')
        const host = target.slice(0, split)
        const port = Number(target.slice(split + 1)) || discoverPort
        udp.send(payload, port, host, () => undefined)
      }
      // 顺手清掉超时的对端（3 个广播周期没消息）
      const now = Date.now()
      for (const [id, peer] of peers) {
        if (now - peer.lastSeen > announceMs * 3) {
          peers.delete(id)
        }
      }
    }
    announce()
    setInterval(announce, announceMs)
  })
})

// ── stdin 控制 ──────────────────────────────────────────────────────────────

const dump = () => {
  const local = records()
  return JSON.stringify({
    device,
    stamp: stampOf(local.values()).slice(0, 12),
    sessions: store.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      messages: session.messages.map((item) => item.id),
    })),
  })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const [command, ...rest] = line.trim().split(/\s+/)
  if (command === 'stats') {
    const local = records()
    log('stats ' + JSON.stringify({ device, records: local.size, ...statsOf(local.values()) }))
    return
  }
  if (command === 'dump') {
    log('dump ' + dump())
    return
  }
  if (command === 'edit') {
    const [sessionId, ...words] = rest
    const session = store.sessions.find((item) => item.id === sessionId)
    if (!session) {
      log('error no-session ' + sessionId)
      return
    }
    const now = Date.now()
    session.messages.push(message('m-' + device + '-' + now, 'user', words.join(' ') || '新消息', now))
    session.updatedAt = now
    log('edited ' + sessionId + ' messages=' + session.messages.length)
    for (const peer of peers.values()) {
      scheduleSync(peer, 0, true)
    }
    return
  }
  if (command === 'delete-session') {
    const [sessionId] = rest
    store.sessions = store.sessions.filter((item) => item.id !== sessionId)
    log('deleted ' + sessionId + ' remaining=' + store.sessions.length)
    for (const peer of peers.values()) {
      scheduleSync(peer, 0, true)
    }
    return
  }
  if (command === 'probe') {
    const [target] = rest
    const [host, portText] = (target ?? '').split(':')
    void (async () => {
      try {
        const reply = await exchange(host, Number(portText), { t: 'ping', device, name })
        log('probe-ok ' + JSON.stringify(reply))
      } catch (error) {
        log('probe-fail ' + error.message)
      }
    })()
    return
  }
  if (command === 'quit') {
    process.exit(0)
  }
})

process.on('SIGTERM', () => process.exit(0))
