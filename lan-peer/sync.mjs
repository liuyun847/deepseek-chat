/**
 * 同步编排：发现 → 配对 → hello 比版本 → 推/拉差异 → 落地。
 *
 * 与手机端 lan/engine.ts 的调度规则逐条对齐（协议没改一行）：
 *   - deviceId 字典序小的一方负责主动同步，大的一方发 ping 催对方来拉；
 *   - 同一个对端的自动同步最小间隔 10 秒，ping 最小间隔 8 秒，本地改动后 4 秒防抖；
 *   - 45 秒一次巡检（只跑 hello，版本一致就结束）。
 * 差别只在「本地改动」的来源：手机看的是 store 里的会话表，电脑看的是数据文件的 mtime。
 */
import { stampOf, statsOf } from './build/src/services/sync/lan/protocol.js'

/** 同一个对端的自动同步最小间隔（与手机端 AUTO_MIN_INTERVAL_MS 一致） */
const AUTO_MIN_INTERVAL_MS = 10_000

/** 催对端来拉的 ping 最小间隔（与手机端 NUDGE_MIN_INTERVAL_MS 一致） */
const NUDGE_MIN_INTERVAL_MS = 8_000

/** 发现到对端后延迟多久动手（给对端一点时间把监听准备好） */
const SCHEDULE_DELAY_MS = 600

/** 本地数据变化后的防抖（与手机端 CHANGE_DEBOUNCE_MS 一致） */
const CHANGE_DEBOUNCE_MS = 4000

/** 流程层的可预期错误；code 供日志与界面分类 */
export class PeerError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'PeerError'
    this.code = code
  }
}

/** 失败原因 → 一句人话（日志用，不含任何数据内容） */
const reasonText = (result) => {
  if (result.reason === 'auth') {
    return '口令不一致（AES-GCM 校验失败）'
  }
  if (result.reason === 'replay') {
    return '重放/重复投递（同一个请求 id 已处理过）'
  }
  if (result.reason === 'too-large') {
    return '包太大（' + (result.detail || '超过上限') + '）'
  }
  if (result.reason === 'unknown-message') {
    return '消息类型不认识'
  }
  return '信封不合法（' + (result.detail || 'format/proto/时间窗口不符') + '）'
}

/**
 * 造一个同步会话。
 *
 * @param {{ codec: object, store: object, exchange: Function, log: object,
 *   self: { deviceId: string, name: string } }} options
 * @returns {object} 见 methods
 */
export const createSession = (options) => {
  const { codec, store, exchange, log, self } = options
  /** deviceId → { deviceId, name, host, port, pairTag, lastSeen } */
  const peers = new Map()
  const lastAuto = new Map()
  const lastNudge = new Map()
  const inFlight = new Set()
  const timers = new Map()
  /** 数据文件「有别人写过」的时刻；同步成功后清零 */
  let dirtyAt = 0
  let debounceTimer = null
  let chain = Promise.resolve()
  /** 最近一次同步结果，供 stdin 的 stats 命令展示 */
  let lastSync = null

  const serialize = (task) => {
    const next = chain.then(task, task)
    chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  const isInitiator = (peerId) => self.deviceId < peerId
  const paired = (peer) => peer.pairTag !== '' && peer.pairTag === codec.pairTag

  /** 本机记录表（一次读取，调用方自己算 stamp） */
  const localRecords = async () => {
    const state = await store.read()
    if (state.corrupt) {
      throw new PeerError('corrupt', '数据文件读不懂：' + state.corrupt)
    }
    return state.records
  }

  /**
   * 发一个请求并等回复。
   *
   * @param {object} peer 对端（含 host / port）
   * @param {object} message 请求消息
   * @returns {Promise<object>} 对端回复的消息
   * @throws {PeerError} code 为 reply-auth / reply-format / network / timeout / closed
   */
  const request = async (peer, message) => {
    const payload = await codec.seal(message)
    const text = await exchange({ host: peer.host, port: peer.port, payload })
    const opened = await codec.open(text)
    if (!opened.ok) {
      throw new PeerError('reply-' + opened.reason, '回复解不开：' + reasonText(opened))
    }
    return opened.message
  }

  /**
   * 处理一个入站请求（TCP 服务收到一帧后调它）。
   *
   * @param {string} text 信封 JSON
   * @returns {Promise<string|null>} 回复的信封 JSON；null 表示不回（对端会等到超时）
   * @sideeffect 收到 sync 时会写数据文件
   */
  const handleRequest = async (text) => {
    const opened = await codec.open(text)
    if (!opened.ok) {
      log.warn('拒绝入站请求：' + reasonText(opened) + (opened.from ? '（来自 ' + opened.from + '）' : ''))
      return null
    }
    const message = opened.message
    const from = opened.envelope.from
    if (message.device !== from) {
      log.warn('入站消息的 device 字段与信封 from 不一致（' + message.device + ' / ' + from + '），按信封为准')
    }
    if (message.t === 'ping') {
      // 对端在说「我这边可能有新东西」：轮到本端发起时立刻同步一次（与手机端一致）
      const peer = peers.get(from)
      if (peer && paired(peer) && isInitiator(from)) {
        scheduleSync(peer, 0, true)
      }
      return codec.seal({ t: 'ping', device: self.deviceId, name: self.name })
    }
    if (message.t === 'hello') {
      const records = await localRecords()
      return codec.seal({
        t: 'hello',
        device: self.deviceId,
        name: self.name,
        stamp: stampOf(records.values()),
        stats: statsOf(records.values()),
      })
    }
    if (message.t === 'sync') {
      const startedAt = Date.now()
      let result = null
      try {
        result = await store.serve(message.records)
      } catch (error) {
        log.error('处理 sync 失败（不回包，对端会超时）：' + (error?.message || String(error)))
        return null
      }
      dirtyAt = 0
      lastSync = {
        at: Date.now(),
        role: 'serve',
        peer: from,
        received: result.received,
        applied: result.applied,
        replied: result.reply.length,
        ms: Date.now() - startedAt,
      }
      log.info(
        '已应答同步 from=' + from + ' 收到=' + result.received + ' 落地=' + result.applied +
          ' 回给对方=' + result.reply.length + ' 用时=' + (Date.now() - startedAt) + 'ms'
      )
      return codec.seal({
        t: 'sync-reply',
        device: self.deviceId,
        name: self.name,
        records: result.reply,
        received: result.received,
        applied: result.applied,
      })
    }
    log.warn('入站消息类型不支持：' + String(message.t))
    return null
  }

  /**
   * 跑一轮同步：hello 比版本 → 有差异才推记录 → 落地对方回的差异。
   *
   * @param {object} peer 对端
   * @param {{ manual?: boolean }} [flags] manual 跳过「必须由我发起」的限制
   * @returns {Promise<object>} 本次结果摘要
   * @throws {PeerError} 见各分支
   * @sideeffect 写数据文件、更新节流表
   */
  const syncWith = (peer, flags = {}) =>
    serialize(async () => {
      if (!flags.manual && !isInitiator(peer.deviceId)) {
        throw new PeerError('not-initiator', '对端 deviceId 更小，由它发起（本端只应答）')
      }
      if (inFlight.has(peer.deviceId)) {
        throw new PeerError('busy', '与 ' + peer.deviceId + ' 的同步正在进行')
      }
      inFlight.add(peer.deviceId)
      const startedAt = Date.now()
      try {
        const records = await localRecords()
        const localStamp = stampOf(records.values())
        const hello = await request(peer, {
          t: 'hello',
          device: self.deviceId,
          name: self.name,
          stamp: localStamp,
          stats: statsOf(records.values()),
        })
        if (hello.t !== 'hello') {
          throw new PeerError('format', 'hello 的回复类型不对：' + String(hello.t))
        }
        if (hello.stamp === localStamp) {
          dirtyAt = 0
          const summary = {
            at: Date.now(),
            role: 'initiate',
            peer: peer.deviceId,
            skipped: 'stamp-equal',
            ms: Date.now() - startedAt,
          }
          lastSync = summary
          log.info('同步完成 peer=' + peer.name + '(' + peer.deviceId + ') 版本一致，无需传记录 用时=' + summary.ms + 'ms')
          return summary
        }
        const reply = await request(peer, {
          t: 'sync',
          device: self.deviceId,
          name: self.name,
          records: [...records.values()],
        })
        if (reply.t !== 'sync-reply') {
          throw new PeerError('format', 'sync 的回复类型不对：' + String(reply.t))
        }
        const applied = await store.applyReply(reply.records)
        dirtyAt = 0
        const summary = {
          at: Date.now(),
          role: 'initiate',
          peer: peer.deviceId,
          received: reply.received,
          applied: reply.applied,
          pulled: applied.pulled,
          ms: Date.now() - startedAt,
        }
        lastSync = summary
        log.info(
          '同步完成 peer=' + peer.name + '(' + peer.deviceId + ') 对端收到=' + reply.received +
            ' 对端落地=' + reply.applied + ' 本端拉取=' + applied.pulled + ' 用时=' + summary.ms + 'ms'
        )
        return summary
      } finally {
        inFlight.delete(peer.deviceId)
      }
    })

  /**
   * 给对端发一个「来拉我」的 ping（对端是发起方时用）。
   *
   * @param {object} peer 对端
   * @returns {Promise<void>}
   */
  const nudge = async (peer) => {
    lastNudge.set(peer.deviceId, Date.now())
    const reply = await request(peer, { t: 'ping', device: self.deviceId, name: self.name })
    if (reply.t !== 'ping') {
      log.warn('ping 的回复类型不对：' + String(reply.t))
      return
    }
    log.info('已通知对端来拉取 peer=' + peer.name + '(' + peer.deviceId + ')')
  }

  /**
   * 安排一次主动同步（同一对端 10 秒内只排一次，force 跳过）。
   *
   * @param {object} peer 对端
   * @param {number} delayMs 延迟
   * @param {boolean} force 跳过最小间隔
   */
  const scheduleSync = (peer, delayMs, force) => {
    if (timers.has('sync:' + peer.deviceId)) {
      return
    }
    const now = Date.now()
    if (!force && now - (lastAuto.get(peer.deviceId) || 0) < AUTO_MIN_INTERVAL_MS) {
      return
    }
    lastAuto.set(peer.deviceId, now)
    const timer = setTimeout(() => {
      timers.delete('sync:' + peer.deviceId)
      void syncWith(peer).catch((error) => {
        log.warn('主动同步失败 peer=' + peer.deviceId + '：' + (error?.message || String(error)))
      })
    }, delayMs)
    timer.unref?.()
    timers.set('sync:' + peer.deviceId, timer)
  }

  /**
   * 安排一次 ping（催对端来拉）。
   *
   * @param {object} peer 对端
   * @param {number} delayMs 延迟
   */
  const scheduleNudge = (peer, delayMs) => {
    if (timers.has('nudge:' + peer.deviceId)) {
      return
    }
    const now = Date.now()
    if (now - (lastNudge.get(peer.deviceId) || 0) < NUDGE_MIN_INTERVAL_MS) {
      return
    }
    const timer = setTimeout(() => {
      timers.delete('nudge:' + peer.deviceId)
      void nudge(peer).catch((error) => {
        log.warn('通知对端失败 peer=' + peer.deviceId + '：' + (error?.message || String(error)))
      })
    }, delayMs)
    timer.unref?.()
    timers.set('nudge:' + peer.deviceId, timer)
  }

  /**
   * 对一批已配对的对端做「该推送就推送、该催就催」。
   *
   * @param {object[]} targets 对端列表（可为空）
   * @param {number} delayMs 延迟
   */
  const fanOut = (targets, delayMs) => {
    for (const peer of targets) {
      if (isInitiator(peer.deviceId)) {
        scheduleSync(peer, delayMs, false)
      } else {
        scheduleNudge(peer, delayMs)
      }
    }
  }

  return {
    /**
     * 发现层报告对端表变化。
     *
     * @param {object[]} list 当前在线对端
     * @param {string} reason new / update / prune
     * @sideeffect 更新内部对端表；新出现的已配对设备立刻进入调度
     */
    onPeers: (list, reason) => {
      const fresh = []
      for (const peer of list) {
        const before = peers.get(peer.deviceId)
        peers.set(peer.deviceId, peer)
        const nowPaired = paired(peer)
        const wasPaired = before ? paired(before) : false
        if (nowPaired && !wasPaired) {
          log.info(
            '发现已配对设备 ' + peer.name + ' device=' + peer.deviceId + ' ' + peer.host + ':' + peer.port +
              ' pairTag=' + peer.pairTag + '（与本机一致）'
          )
          fresh.push(peer)
        } else if (!nowPaired && !wasPaired && !before) {
          log.info(
            '发现设备 ' + peer.name + ' device=' + peer.deviceId + ' ' + peer.host + ':' + peer.port +
              ' pairTag=' + (peer.pairTag || '(空)') + ' ≠ 本机 ' + codec.pairTag + '，口令不一致 → 不配对、不同步'
          )
        } else if (!nowPaired && wasPaired) {
          log.warn('设备 ' + peer.deviceId + ' 的口令指纹变了（pairTag=' + (peer.pairTag || '(空)') + '），不再视为已配对')
        }
      }
      for (const peer of fresh) {
        fanOut([peer], SCHEDULE_DELAY_MS)
      }
      if (reason === 'prune') {
        const alive = new Set(list.map((peer) => peer.deviceId))
        for (const id of [...peers.keys()]) {
          if (!alive.has(id)) {
            peers.delete(id)
          }
        }
      }
    },

    /** 入站请求处理（交给 TCP 服务） */
    handleRequest,

    /**
     * 数据文件被别的东西改了（网页端推到 7788、或人工编辑）：攒 4 秒后推一轮。
     *
     * @sideeffect 防抖定时器；到点后对已配对设备主动同步或 ping
     */
    onFileChanged: () => {
      dirtyAt = Date.now()
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        fanOut([...peers.values()].filter(paired), 0)
      }, CHANGE_DEBOUNCE_MS)
      debounceTimer.unref?.()
    },

    /**
     * 45 秒巡检：已配对设备各跑一次（发起方 hello 比版本，应答方只在有改动时 ping）。
     *
     * @sideeffect 排同步任务 + 数据文件覆盖层修补
     */
    tick: () => {
      const targets = [...peers.values()].filter(paired)
      if (targets.length > 0) {
        const stale = dirtyAt > 0 ? targets : targets.filter((peer) => isInitiator(peer.deviceId))
        fanOut(stale, 0)
      }
      void store
        .repair()
        .then((result) => {
          if (result.restored > 0) {
            log.warn(
              '数据文件里有 ' + result.restored + ' 条记录缺失（多半是 7788 用它自己的内存视图整份覆盖过），已按 LWW 补回'
            )
          }
          if (result.skipped) {
            log.warn('跳过覆盖层修补：' + result.skipped)
          }
        })
        .catch((error) => {
          log.warn('覆盖层修补失败：' + (error?.message || String(error)))
        })
    },

    /**
     * 手动同步所有已配对设备（stdin 的 sync 命令）。
     * @returns {Promise<object[]>} 每台的结果
     */
    syncAll: async () => {
      const results = []
      for (const peer of [...peers.values()].filter(paired)) {
        try {
          results.push(await syncWith(peer, { manual: true }))
        } catch (error) {
          log.warn('手动同步失败 peer=' + peer.deviceId + '：' + (error?.message || String(error)))
          results.push({ peer: peer.deviceId, ok: false, error: error?.message || String(error) })
        }
      }
      return results
    },

    /**
     * 手动探活一台设备（stdin 的 probe 命令）：发一个 ping，验证口令是否一致。
     *
     * @param {string} host 地址
     * @param {number} port 端口
     * @returns {Promise<object>} 对端回的 ping 消息
     */
    probe: (host, port) => request({ deviceId: 'probe', name: 'probe', host, port }, {
      t: 'ping',
      device: self.deviceId,
      name: self.name,
    }),

    peers: () => [...peers.values()],
    pairedPeers: () => [...peers.values()].filter(paired),
    lastSync: () => lastSync,

    /** 收尾：清掉未触发的定时器 */
    close: () => {
      for (const [key, timer] of timers) {
        clearTimeout(timer)
        timers.delete(key)
      }
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
    },
  }
}
