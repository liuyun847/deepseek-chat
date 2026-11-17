/**
 * UDP 发现：47823 端口广播 + 监听。
 *
 * 与手机端（android/java/ds/app/LanLink.java）同一份规则：
 *   - 每 4 秒往 255.255.255.255 与每块网卡的广播地址各发一份 {format, proto, deviceId, name, port, pairTag}；
 *   - 3 个周期（14 秒）没消息就把对端判离线；
 *   - 对端地址一律取数据包的来源地址 rinfo.address，不信 JSON 里的字段（JSON 可伪造，来源不可）。
 *
 * 这里只维护「谁在线」，配对与同步由上层决定（见 sync.mjs）。
 */
import dgram from 'node:dgram'
import os from 'node:os'

import { LAN_FORMAT, LAN_PROTO } from './build/src/services/sync/lan/protocol.js'

/** 广播周期：与手机端一致 */
const ANNOUNCE_INTERVAL_MS = 4000

/** 对端有效期：3 个广播周期 + 2 秒（与手机端 PEER_TTL_MS 一致） */
const PEER_TTL_MS = ANNOUNCE_INTERVAL_MS * 3 + 2000

/** 收广播的缓冲：正常的广播包只有一百多字节，超过 2 KB 的一律当噪声 */
const RECEIVE_BUFFER = 2048

/** 同一个广播目标发送失败时，最多每 30 秒记一次日志（多网卡下会刷屏） */
const SEND_ERROR_INTERVAL_MS = 30_000

/** 发现层的可预期错误 */
export class DiscoveryError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'DiscoveryError'
    this.code = code
  }
}

/** 点分十进制 → 32 位无符号整数 */
const ipToInt = (ip) => {
  const parts = String(ip).split('.')
  if (parts.length !== 4) {
    return null
  }
  let value = 0
  for (const part of parts) {
    const byte = Number(part)
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      return null
    }
    value = value * 256 + byte
  }
  return value >>> 0
}

/** 32 位无符号整数 → 点分十进制 */
const intToIp = (value) => {
  const num = value >>> 0
  return [num >>> 24, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.')
}

/**
 * 枚举本机的 IPv4 网卡与其广播地址。
 *
 * @returns {{ name: string, address: string, netmask: string, broadcast: string }[]}
 */
export const listInterfaces = () => {
  const list = []
  const all = os.networkInterfaces()
  for (const [name, addresses] of Object.entries(all)) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal) {
        continue
      }
      const address = ipToInt(item.address)
      const mask = ipToInt(item.netmask)
      if (address === null || mask === null) {
        continue
      }
      const broadcast = intToIp(((address & mask) | (~mask & 0xffffffff)) >>> 0)
      list.push({ name, address: item.address, netmask: item.netmask, broadcast })
    }
  }
  return list
}

/**
 * 算出要广播的地址列表。
 *
 * @param {string} iface --iface 的取值：空串 = 全部网卡；网卡地址 = 只用那块；
 *   广播地址 = 直接用它
 * @returns {{ targets: string[], chosen: object[], unknown: boolean }}
 *   targets 去重后的广播目标；chosen 参与广播的网卡；unknown 表示 --iface 没匹配到网卡
 */
export const resolveTargets = (iface) => {
  const interfaces = listInterfaces()
  if (!iface) {
    const targets = ['255.255.255.255']
    for (const item of interfaces) {
      if (!targets.includes(item.broadcast)) {
        targets.push(item.broadcast)
      }
    }
    return { targets, chosen: interfaces, unknown: false }
  }
  const matched = interfaces.filter((item) => item.address === iface)
  if (matched.length > 0) {
    return { targets: [matched[0].broadcast], chosen: matched, unknown: false }
  }
  const byBroadcast = interfaces.filter((item) => item.broadcast === iface)
  if (byBroadcast.length > 0) {
    return { targets: [byBroadcast[0].broadcast], chosen: byBroadcast, unknown: false }
  }
  if (ipToInt(iface) !== null) {
    // --iface 直接写了个广播地址（或本机没配那种地址）：照它发，不再猜
    return { targets: [iface], chosen: [], unknown: true }
  }
  return { targets: ['255.255.255.255'], chosen: interfaces, unknown: true }
}

/**
 * 造一个发现对象。
 *
 * @param {{ deviceId: string, name: string, tcpPort: number, pairTag: string, udpPort: number,
 *   iface: string, log: object, onPeers: (peers: object[], reason: string) => void }} options
 * @returns {Promise<object>} { peers, announce, close, lastAnnounceAt, stats }
 * @sideeffect 绑定 UDP 端口并开一个 4 秒的广播定时器
 * @throws {DiscoveryError} code 为 bind（端口被别的程序独占）
 */
export const createDiscovery = async (options) => {
  const log = options.log
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const peers = new Map()
  const sendErrors = new Map()
  let lastAnnounceAt = 0
  let announceOk = false
  let announceTimer = null
  let closed = false
  const resolved = resolveTargets(options.iface)

  if (resolved.unknown) {
    log.warn('--iface ' + options.iface + ' 没有匹配到本机网卡，按给定地址直接发广播')
  }

  /** 关掉时把定时器与 socket 一起收掉（幂等） */
  const close = async () => {
    if (closed) {
      return
    }
    closed = true
    if (announceTimer !== null) {
      clearInterval(announceTimer)
      announceTimer = null
    }
    await new Promise((resolve) => {
      try {
        socket.close(() => resolve())
      } catch (error) {
        resolve()
      }
    })
  }

  const announcePayload = () =>
    JSON.stringify({
      format: LAN_FORMAT,
      proto: LAN_PROTO,
      deviceId: options.deviceId,
      name: options.name,
      port: options.tcpPort,
      pairTag: options.pairTag,
    })

  /**
   * 清理超时对端。
   * @returns {boolean} 是否有对端被移除
   */
  const prune = () => {
    const now = Date.now()
    let changed = false
    for (const [id, peer] of peers) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        peers.delete(id)
        log.info('对端离线 ' + id + '（' + peer.host + ':' + peer.port + '）')
        changed = true
      }
    }
    return changed
  }

  /** 发一轮广播（多网卡各发一份，单个目标失败不影响其它） */
  const announce = () => {
    if (closed) {
      return
    }
    const payload = Buffer.from(announcePayload(), 'utf8')
    let ok = false
    for (const target of resolved.targets) {
      try {
        socket.send(payload, options.udpPort, target, (error) => {
          if (error) {
            reportSendError(target, error)
          }
        })
        ok = true
      } catch (error) {
        reportSendError(target, error)
      }
    }
    lastAnnounceAt = Date.now()
    announceOk = ok
    if (prune()) {
      options.onPeers([...peers.values()], 'prune')
    }
  }

  /** 发送失败日志节流：同一目标 30 秒最多一条 */
  const reportSendError = (target, error) => {
    const now = Date.now()
    const last = sendErrors.get(target) || 0
    if (now - last < SEND_ERROR_INTERVAL_MS) {
      return
    }
    sendErrors.set(target, now)
    log.warn('广播到 ' + target + ' 失败（' + (error?.code || error?.message || 'unknown') + '），该网段的对端可能发现不了本机')
  }

  /**
   * 处理一条广播。
   *
   * @param {Buffer} buffer 数据包内容
   * @param {{ address: string, port: number }} rinfo 来源信息
   */
  const handleAnnounce = (buffer, rinfo) => {
    if (buffer.length === 0 || buffer.length > RECEIVE_BUFFER) {
      return
    }
    let parsed = null
    try {
      parsed = JSON.parse(buffer.toString('utf8'))
    } catch (error) {
      return
    }
    if (!parsed || typeof parsed !== 'object' || parsed.format !== LAN_FORMAT || parsed.proto !== LAN_PROTO) {
      return
    }
    const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : ''
    const port = Number(parsed.port)
    if (!deviceId || deviceId === options.deviceId) {
      return
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return
    }
    const previous = peers.get(deviceId)
    const next = {
      deviceId,
      name: typeof parsed.name === 'string' ? parsed.name : deviceId,
      host: rinfo.address,
      port,
      pairTag: typeof parsed.pairTag === 'string' ? parsed.pairTag : '',
      lastSeen: Date.now(),
      firstSeen: previous ? previous.firstSeen : Date.now(),
    }
    peers.set(deviceId, next)
    const changed =
      !previous ||
      previous.host !== next.host ||
      previous.port !== next.port ||
      previous.pairTag !== next.pairTag ||
      previous.name !== next.name
    if (changed) {
      options.onPeers([...peers.values()], previous ? 'update' : 'new')
    }
  }

  socket.on('error', (error) => {
    log.error('UDP 发现出错：' + error.message)
  })
  socket.on('message', handleAnnounce)

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      reject(new DiscoveryError('bind', '绑定 UDP ' + options.udpPort + ' 失败：' + error.message))
    }
    socket.once('error', onError)
    socket.bind({ port: options.udpPort, address: '0.0.0.0' }, () => {
      socket.off('error', onError)
      try {
        socket.setBroadcast(true)
      } catch (error) {
        log.warn('打开发广播失败：' + error.message)
      }
      resolve()
    })
  })

  announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS)
  announce()

  return {
    peers: () => [...peers.values()],
    announce,
    close,
    lastAnnounceAt: () => lastAnnounceAt,
    announceOk: () => announceOk,
    targets: () => resolved.targets,
    interfaces: () => resolved.chosen,
  }
}
