/**
 * TCP 传输层：4 字节大端长度 + UTF-8 正文的帧，一问一答。
 *
 * 为什么不是「读到 EOF」：手机端（LanLink.java）用的是长度前缀，而半关在部分代理/NAT 上
 * 不可靠；两端口径必须一致，所以这里照抄它的组帧方式。
 *
 * 只搬字节：请求正文是加密信封，这一层不解析、不记录内容，只记录长度与耗时。
 */
import net from 'node:net'

/** 单帧上限：与 Java 侧 MAX_PAYLOAD（40 MB）一致 */
export const MAX_FRAME_BYTES = 40 * 1024 * 1024

/** 连接读超时：等对端把一帧发完的上限（手机端 READ_TIMEOUT_MS） */
const READ_TIMEOUT_MS = 20_000

/** 连接建立超时：手机端连不上就不必干等 */
const CONNECT_TIMEOUT_MS = 5_000

/** 同时处理的入站连接上限：个人局域网里正常不会超过个位数，超了直接拒 */
const MAX_CONNECTIONS = 64

/** 传输层的可预期错误；code 供上层分类打日志 */
export class TransportError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'TransportError'
    this.code = code
  }
}

/**
 * 组帧：4 字节大端长度 + 正文。
 *
 * @param {string} text 正文
 * @returns {Buffer} 可直接写进 socket 的字节
 */
export const frameOf = (text) => {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

/**
 * 从 socket 读一帧。
 *
 * @param {net.Socket} socket 已连接的 socket（本函数不关闭它）
 * @param {{ limit?: number }} [options]
 * @returns {Promise<string>} 正文
 * @throws {TransportError} code 为 too-large（声明长度超限）或 closed（对端提前断开）
 */
export const readFrame = (socket, options = {}) => {
  const limit = options.limit || MAX_FRAME_BYTES
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let expected = -1
    let settled = false

    const finish = (error, text) => {
      if (settled) {
        return
      }
      settled = true
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
      socket.off('error', onError)
      if (error) {
        reject(error)
      } else {
        resolve(text)
      }
    }

    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (expected < 0 && buffer.length >= 4) {
        expected = buffer.readUInt32BE(0)
        buffer = buffer.subarray(4)
        if (expected <= 0 || expected > limit) {
          finish(new TransportError('too-large', '帧长度不合法: ' + expected + '（上限 ' + limit + '）'))
          return
        }
      }
      if (expected >= 0 && buffer.length >= expected) {
        finish(null, buffer.subarray(0, expected).toString('utf8'))
      }
    }
    const onEnd = () => finish(new TransportError('closed', '对端在发完整帧之前关闭了连接'))
    const onError = (error) => finish(new TransportError('network', error.message))

    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onEnd)
    socket.on('error', onError)
  })
}

/**
 * 造入站服务：每个连接读一帧、交给 onRequest、把返回值写回去再关连接。
 *
 * @param {{ onRequest: (text: string) => Promise<string|null>, log: object,
 *   readTimeoutMs?: number, maxBytes?: number }} options
 *   onRequest 返回 null 表示「不回内容，直接关连接」（与手机端 reply 传 null 等价）
 * @returns {{ server: net.Server, listen: Function, close: Function, activeCount: Function }}
 */
export const createRequestServer = (options) => {
  const log = options.log
  const readTimeoutMs = options.readTimeoutMs || READ_TIMEOUT_MS
  const maxBytes = options.maxBytes || MAX_FRAME_BYTES
  let active = 0

  const handle = async (socket) => {
    socket.setNoDelay(true)
    socket.setTimeout(readTimeoutMs, () => {
      log.warn('入站连接读超时（' + readTimeoutMs + ' ms），关闭')
      socket.destroy()
    })
    try {
      const text = await readFrame(socket, { limit: maxBytes })
      const reply = await options.onRequest(text)
      if (reply) {
        socket.write(frameOf(reply), () => socket.end())
      } else {
        socket.end()
      }
    } catch (error) {
      // 连接级的失败只记一行，绝不让它冒到进程顶层
      log.warn('入站连接失败：' + (error?.message || String(error)))
      socket.destroy()
    }
  }

  const server = net.createServer((socket) => {
    if (active >= MAX_CONNECTIONS) {
      log.warn('入站连接数已达上限 ' + MAX_CONNECTIONS + '，拒绝新连接')
      socket.destroy()
      return
    }
    active += 1
    socket.on('close', () => {
      active -= 1
    })
    socket.on('error', () => {
      // 对端强制断开时 socket 会发 error，这里吞掉（close 事件照常触发）
    })
    void handle(socket)
  })

  server.on('error', (error) => {
    log.error('TCP 服务出错：' + error.message)
  })

  return {
    server,
    /**
     * 开始监听。
     * @param {number} port 0 表示随机
     * @param {string} host 绑定的地址
     * @returns {Promise<number>} 实际端口
     * @throws {TransportError} code 为 bind（端口被占用等）
     */
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          reject(new TransportError('bind', error.message))
        }
        server.once('error', onError)
        server.listen(port, host, () => {
          server.off('error', onError)
          resolve(server.address().port)
        })
      }),
    close: () =>
      new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch (error) {
          resolve()
        }
      }),
    activeCount: () => active,
  }
}

/**
 * 发一个请求并等回复（一问一答，一次连接）。
 *
 * @param {{ host: string, port: number, payload: string, readTimeoutMs?: number,
 *   connectTimeoutMs?: number, maxBytes?: number }} options
 * @returns {Promise<string>} 回复信封原文
 * @throws {TransportError} code 为 refused / timeout / network / too-large / closed
 */
export const exchange = (options) => {
  const readTimeoutMs = options.readTimeoutMs || READ_TIMEOUT_MS
  const connectTimeoutMs = options.connectTimeoutMs || CONNECT_TIMEOUT_MS
  const maxBytes = options.maxBytes || MAX_FRAME_BYTES
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (error, text) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(text)
      }
    }
    socket.setNoDelay(true)
    socket.once('error', (error) => finish(new TransportError('network', error.code || error.message)))
    socket.setTimeout(connectTimeoutMs, () => finish(new TransportError('timeout', '连接超时')))
    socket.connect(options.port, options.host, () => {
      socket.setTimeout(readTimeoutMs, () => finish(new TransportError('timeout', '等回复超时')))
      socket.write(frameOf(options.payload))
      readFrame(socket, { limit: maxBytes }).then(
        (text) => finish(null, text),
        (error) => {
          if (error.code === 'closed') {
            finish(new TransportError('closed', '对端没有回包就关闭了连接（可能是不认这个口令）'))
            return
          }
          finish(error)
        }
      )
    })
  })
}
