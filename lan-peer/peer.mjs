#!/usr/bin/env node
/**
 * 电脑端「手机直连」对端：让手机 APK 通过局域网 P2P 直接与电脑同步，不经 HTTP。
 *
 * 它替手机端扮演的角色一模一样（协议一行没改）：UDP 47823 广播发现、TCP 随机端口一问一答、
 * AES-GCM 信封、pairTag 配对、LWW + 墓碑合并。唯一的不同是数据落在电脑上的一个 JSON 文件里，
 * 而这个文件就是 sync-server（HTTP 同步，7788）用的那一份 —— 于是手机 P2P 同步过来的会话，
 * 网页端下次连 7788 也能读到。
 *
 * 用法：
 *   node lan-peer/peer.mjs --passphrase <口令> [--port 0] [--name 电脑] [--data <文件>] [--iface <地址>]
 *   stdin 命令：stats / peers / sync / probe <host:port> / quit
 *
 * 环境变量：LAN_PASSPHRASE（口令）、LAN_NAME（设备名）、LAN_DATA（数据文件）
 */
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

import { ConfigError, resolveConfig, usageText } from './config.mjs'
import { createDiscovery, DiscoveryError, listInterfaces } from './discovery.mjs'
import { createCodec } from './envelope.mjs'
import { createLogger } from './log.mjs'
import { createStore } from './store.mjs'
import { createSession } from './sync.mjs'
import { createRequestServer, exchange, TransportError } from './transport.mjs'

/** 本程序版本（写进 state.json 与启动横幅，便于对日志） */
const VERSION = '1.0.0'

/** 状态文件：start.ps1 的健康自检与 stop.ps1 的定位都靠它 */
const STATE_FILE = 'state.json'

/** 状态刷新与文件监听的周期：4 秒，与广播同频 */
const POLL_INTERVAL_MS = 4000

/** 45 秒巡检：与手机端 TICK_MS 一致 */
const TICK_INTERVAL_MS = 45_000

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 探一个 TCP 端口是否有监听（只用于启动时提示「7788 也在跑」）。
 *
 * @param {string} host 地址
 * @param {number} port 端口
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<boolean>} 有监听返回 true
 */
const probePort = (host, port, timeoutMs = 300) =>
  new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host, () => done(true))
  })

/** 主流程 */
const main = async () => {
  let config = null
  try {
    config = await resolveConfig(process.argv.slice(2), { rootDir: HERE, env: process.env })
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('参数错误：' + error.message)
      console.error('')
      console.error(usageText())
      process.exit(2)
    }
    throw error
  }
  if (config.help) {
    console.log(usageText())
    return
  }

  const log = createLogger({ dir: config.logDir, secrets: [config.passphrase] })
  const stateFile = path.join(config.logDir, STATE_FILE)
  const startedAt = Date.now()
  let tcpPort = 0
  let lastSyncAt = 0
  let closing = false
  let discovery = null

  /**
   * 写状态文件（原子写：临时文件 + rename）。
   *
   * @param {object} extra 额外字段（例如 stopped: true）
   * @sideeffect 覆盖 logs/state.json
   */
  const writeState = async (extra = {}) => {
    const stat = await store.stats().catch(() => ({ records: 0 }))
    const last = sessionRef.current ? sessionRef.current.lastSync() : null
    const payload = {
      service: 'deepseek-chat-lan-peer',
      version: VERSION,
      pid: process.pid,
      deviceId: config.deviceId,
      name: config.name,
      tcpPort,
      udpPort: config.udpPort,
      pairTag: codec.pairTag,
      dataFile: config.dataFile,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      records: stat.records,
      lastAnnounceAt: discovery ? discovery.lastAnnounceAt() : 0,
      announceOk: discovery ? discovery.announceOk() : false,
      peers: sessionRef.current ? sessionRef.current.peers().length : 0,
      paired: sessionRef.current ? sessionRef.current.pairedPeers().length : 0,
      lastSyncAt: last ? last.at : 0,
      ...extra,
    }
    const tmp = stateFile + '.tmp'
    try {
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      await fsp.rename(tmp, stateFile)
    } catch (error) {
      log.warn('状态文件写入失败：' + error.message)
    }
  }

  /** 同步会话的持有者：TCP 服务先建，session 后建，靠它接上 */
  const sessionRef = { current: null }
  let store = null

  log.info('=== lan-peer ' + VERSION + ' 启动 ===')
  log.info('设备 device=' + config.deviceId + ' name=' + config.name + (config.deviceFresh ? '（首次生成并已落盘）' : ''))
  log.info('数据文件 ' + config.dataFile)
  log.info('日志 ' + log.file)

  // ── 密钥 ────────────────────────────────────────────────────────────────
  let codec = null
  try {
    const began = Date.now()
    codec = await createCodec({ passphrase: config.passphrase, deviceId: config.deviceId, log })
    log.info('口令已配置（PBKDF2 派生 ' + (Date.now() - began) + ' ms），广播指纹 pairTag=' + codec.pairTag)
  } catch (error) {
    log.error('派生密钥失败：' + (error?.message || String(error)))
    process.exit(1)
  }

  // ── 数据文件 ────────────────────────────────────────────────────────────
  store = createStore({ file: config.dataFile, log })
  const initial = await store.stats()
  if (initial.corrupt) {
    log.error('数据文件读不懂，本次不参与写入（避免覆盖用户数据）：' + initial.corrupt)
  } else {
    log.info(
      '数据文件已载入：记录 ' + initial.records + ' 条（会话 ' + initial.sessions + '，消息 ' + initial.messages +
        '，墓碑 ' + initial.tombstones + '）' + (initial.invalid ? '，跳过非法记录 ' + initial.invalid + ' 条' : '')
    )
  }

  if (await probePort('127.0.0.1', 7788)) {
    log.warn('检测到 127.0.0.1:7788 上还有 sync-server 在跑：它与本程序共用同一份数据文件。')
    log.warn('  两边都按「读最新 → 合并 → 原子写」处理，但 7788 会用自己的内存视图整份覆盖，')
    log.warn('  期间只有 P2P 才有的记录会短暂消失，由本程序每 45 秒的覆盖层修补按 LWW 补回。')
    log.warn('  想彻底避免就二选一：要么只用 P2P，要么停掉 7788 再让手机走 HTTP。')
  }

  const interfaces = listInterfaces()
  if (interfaces.length === 0) {
    log.warn('没有找到非回环 IPv4 网卡：本机不在局域网里，手机将发现不到它')
  }

  // ── TCP 服务（先起来，广播里才有正确的端口） ─────────────────────────────
  const server = createRequestServer({
    log,
    onRequest: (text) => {
      if (!sessionRef.current) {
        log.warn('同步会话还没就绪，拒绝这次入站请求')
        return null
      }
      return sessionRef.current.handleRequest(text)
    },
  })
  try {
    tcpPort = await server.listen(config.port, '0.0.0.0')
  } catch (error) {
    log.error('TCP 监听失败：' + (error?.message || String(error)))
    if (error instanceof TransportError && error.code === 'bind') {
      log.error('端口 ' + config.port + ' 被占用：换一个 --port，或先停掉占用它的程序')
    }
    process.exit(2)
  }
  log.info('TCP 已监听 0.0.0.0:' + tcpPort + '（对端靠广播里的 port 找到这里）')

  // ── 同步会话 ────────────────────────────────────────────────────────────
  const session = createSession({
    codec,
    store,
    log,
    exchange,
    self: { deviceId: config.deviceId, name: config.name },
  })
  sessionRef.current = session

  // ── 发现（端口已知，广播内容一次到位） ───────────────────────────────────
  discovery = await createDiscovery({
    deviceId: config.deviceId,
    name: config.name,
    tcpPort,
    pairTag: codec.pairTag,
    udpPort: config.udpPort,
    iface: config.iface,
    log,
    onPeers: (list, reason) => session.onPeers(list, reason),
  }).catch(async (error) => {
    if (error instanceof DiscoveryError) {
      log.error(error.message)
      log.error('端口被占用时：先关掉占用的程序；换 --udp-port 会让手机（固定 47823）发现不到本机')
      await server.close()
      process.exit(2)
    }
    throw error
  })
  log.info('UDP 已监听 0.0.0.0:' + config.udpPort + '，广播目标 ' + discovery.targets().join(', '))
  for (const item of interfaces) {
    log.info('  网卡 ' + item.name + ' ' + item.address + '/' + item.netmask + ' 广播 ' + item.broadcast)
  }
  log.info('就绪：pairTag=' + codec.pairTag + '，手机在「设置 → 手机直连」里填同一个口令即可')

  await writeState()

  // ── 定时器 ──────────────────────────────────────────────────────────────
  let lastSignature = ''
  const poll = setInterval(() => {
    void (async () => {
      const last = session.lastSync()
      if (last && last.at > lastSyncAt) {
        lastSyncAt = last.at
      }
      await writeState()
      // 数据文件被别人改了？（网页端推到 7788、人工编辑、或另一个 P2P 实例）
      try {
        const info = await fsp.stat(config.dataFile)
        const signature = String(info.mtimeMs) + ':' + String(info.size)
        if (lastSignature === '') {
          lastSignature = signature
        } else if (signature !== lastSignature) {
          lastSignature = signature
          if (Date.now() - store.lastWriteAt() > 2000) {
            session.onFileChanged()
          }
        }
      } catch (error) {
        // 文件还没建出来（第一次同步才会创建）属于正常
      }
    })()
  }, POLL_INTERVAL_MS)

  const ticker = setInterval(() => {
    session.tick()
  }, TICK_INTERVAL_MS)

  // ── stdin 控制 ──────────────────────────────────────────────────────────
  const showStats = async () => {
    const stat = await store.stats()
    log.info(
      'stats ' + JSON.stringify({
        device: config.deviceId,
        name: config.name,
        tcpPort,
        udpPort: config.udpPort,
        pairTag: codec.pairTag,
        dataFile: config.dataFile,
        file: stat,
        peers: session.peers().length,
        paired: session.pairedPeers().length,
        lastSync: session.lastSync(),
      })
    )
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    const [command, ...rest] = trimmed.split(/\s+/)
    if (command === 'stats') {
      void showStats()
      return
    }
    if (command === 'peers') {
      for (const peer of session.peers()) {
        log.info(
          'peer ' + peer.deviceId + ' ' + peer.name + ' ' + peer.host + ':' + peer.port +
            ' pairTag=' + (peer.pairTag || '(空)') + ' lastSeen=' + peer.lastSeen
        )
      }
      if (session.peers().length === 0) {
        log.info('peer （还没发现任何设备）')
      }
      return
    }
    if (command === 'sync') {
      void session.syncAll().then((results) => {
        log.info('手动同步结束：' + JSON.stringify(results))
      })
      return
    }
    if (command === 'probe') {
      const target = (rest[0] || '').split(':')
      const port = Number(target[1])
      if (!target[0] || !Number.isInteger(port) || port <= 0) {
        log.warn('用法：probe <host:port>')
        return
      }
      void session
        .probe(target[0], port)
        .then((reply) => {
          log.info('探活成功：对端 device=' + reply.device + ' name=' + reply.name + '（口令一致）')
        })
        .catch((error) => {
          log.warn('探活失败：' + (error?.message || String(error)))
        })
      return
    }
    if (command === 'help') {
      log.info('命令：stats / peers / sync / probe <host:port> / quit')
      return
    }
    if (command === 'quit' || command === 'exit') {
      void shutdown('stdin quit', 0)
      return
    }
    log.warn('不认识的命令：' + command + '（help 看列表）')
  })

  // ── 收尾 ────────────────────────────────────────────────────────────────
  const shutdown = async (reason, code) => {
    if (closing) {
      return
    }
    closing = true
    log.info('正在停止（' + reason + '）')
    clearInterval(poll)
    clearInterval(ticker)
    session.close()
    try {
      rl.close()
    } catch (error) {
      // 非交互环境里 stdin 可能已经关了
    }
    await server.close()
    if (discovery) {
      await discovery.close()
    }
    await writeState({ stopped: true, stoppedAt: Date.now() })
    log.info('=== lan-peer 已停止 ===')
    process.exit(code)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0)
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0)
  })
  process.on('uncaughtException', (error) => {
    log.error('未捕获异常（进程继续）：' + (error?.stack || String(error)))
  })
  process.on('unhandledRejection', (error) => {
    log.error('未处理的 Promise 拒绝（进程继续）：' + (error?.stack || String(error)))
  })
}

main().catch((error) => {
  console.error('启动失败：' + (error?.stack || String(error)))
  process.exit(1)
})
