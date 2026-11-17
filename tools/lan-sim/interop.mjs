/**
 * 真机（模拟器）联调：让宿主进程扮演「另一台手机」，向安卓端推一次真实同步。
 *
 * 为什么需要它
 * ==========
 * 雷电模拟器的客户机没有默认路由（netstat -rn 只有 172.16.1.0/24），收不到宿主机的
 * 单播，也没法主动连回宿主机 —— 所以「两端互相发现」在单模拟器上做不到（报告里如实写明）。
 * 但方向反过来是通的：用 adb forward tcp:<宿主端口> tcp:<客户机端口> 把宿主的连接
 * 送进安卓端监听的端口，于是可以验证真正重要的那半条链路：
 *
 *   宿主进程 → Java ServerSocket → Bridge.onRequest → 页面解密(AES-GCM)
 *   → 合并(planTransfer) → 写 IndexedDB → 加密回包 → 宿主进程解密校验
 *
 * 用法：
 *   adb forward tcp:47826 tcp:<安卓端 TCP 端口>
 *   node interop.mjs --port 47826 --pass lan-test-2026
 */
import net from 'node:net'

import { deriveKeyBytes, importLanKey, openMessage, pairTagOf, sealMessage } from './build/src/services/sync/lan/crypto.js'
import { applyPulledRecords, buildLocalRecords, recordsToSnapshots } from './build/src/services/sync/merge.js'
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
import { planClientApply } from './build/src/services/sync/lan/transfer.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const host = argOf('host', '127.0.0.1')
const port = Number(argOf('port', '47826'))
const passphrase = argOf('pass', 'lan-test-2026')
const device = argOf('id', 'dev-zhost')
const name = argOf('name', '宿主机模拟端')

const keyBytes = await deriveKeyBytes(passphrase)
const key = await importLanKey(keyBytes)
const pairTag = await pairTagOf(keyBytes)
console.log('本端 device=' + device + ' pairTag=' + pairTag)

const message = (id, role, content, createdAt) => ({ id, role, content, createdAt, files: [] })
const store = {
  sessions: [
    {
      id: 'host-s1',
      title: '来自宿主机的会话',
      createdAt: 1760000000000,
      updatedAt: 1760000000500,
      messages: [message('host-m1', 'user', '这条消息应该出现在安卓端', 1760000000100)],
    },
    {
      id: 'host-s2',
      title: '宿主机的第二个会话',
      createdAt: 1760000001000,
      updatedAt: 1760000001500,
      messages: [message('host-m2', 'assistant', '第二条，用来验证多条记录一起合并', 1760000001100)],
    },
  ],
  snapshots: new Map(),
}

const records = () =>
  buildLocalRecords({ sessions: store.sessions, snapshots: store.snapshots, device, now: Date.now() }).records

const saveSnapshotsFrom = (map) => {
  store.snapshots = new Map(recordsToSnapshots(map.values()).map((snapshot) => [snapshot.key, snapshot]))
}

/** 组帧 / 收帧：4 字节大端长度 + UTF-8 正文，与 Java 侧 LanLink 一致 */
const frameOf = (text) => {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

const readFrame = (socket) =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let expected = -1
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (expected < 0 && buffer.length >= 4) {
        expected = buffer.readUInt32BE(0)
        buffer = buffer.subarray(4)
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

const exchange = (payload) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => socket.write(frameOf(payload)))
    socket.setTimeout(20000, () => socket.destroy(new Error('超时')))
    socket.on('error', reject)
    readFrame(socket)
      .then((text) => {
        socket.end()
        resolve(text)
      })
      .catch(reject)
  })

const seal = async (body) => {
  const id = createRequestId()
  const ts = Date.now()
  const sealed = await sealMessage(key, envelopeAad({ from: device, id, ts }), body)
  return JSON.stringify({ format: LAN_FORMAT, proto: LAN_PROTO, from: device, id, ts, iv: sealed.iv, data: sealed.data })
}

const open = async (text) => {
  const envelope = parseEnvelope(JSON.parse(text), Date.now())
  if (!envelope) {
    throw new Error('信封不合法')
  }
  const body = await openMessage(key, envelopeAad(envelope), { iv: envelope.iv, data: envelope.data })
  const parsed = parseMessage(body)
  if (!parsed) {
    throw new Error('消息结构不合法')
  }
  return parsed
}

const main = async () => {
  const local = records()
  const localStamp = stampOf(local.values())
  const helloText = await exchange(
    await seal({ t: 'hello', device, name, stamp: localStamp, stats: statsOf(local.values()) })
  )
  if (!helloText) {
    throw new Error('安卓端没有响应（检查 adb forward 与安卓端端口）')
  }
  const hello = await open(helloText)
  console.log(
    'hello 应答: device=' + hello.device + ' stamp=' + hello.stamp.slice(0, 12) + ' stats=' + JSON.stringify(hello.stats)
  )

  const syncText = await exchange(await seal({ t: 'sync', device, name, records: [...local.values()] }))
  const reply = await open(syncText)
  if (reply.t !== 'sync-reply') {
    throw new Error('sync 应答类型不对：' + reply.t)
  }
  console.log(
    'sync 应答: 安卓端收到 ' + reply.received + ' 条，落地 ' + reply.applied + ' 条，回给我 ' + reply.records.length + ' 条'
  )
  console.log('安卓端回给我的记录: ' + (reply.records.map((item) => item.kind + ':' + item.id).join(',') || '（空）'))

  const plan = planClientApply(local, reply.records)
  applyPulledRecords(store.sessions, plan.pulled)
  saveSnapshotsFrom(plan.merged)
  console.log('本端落库后 stamp=' + stampOf(records().values()).slice(0, 12))
  // 第一次跑：安卓端会落地若干条（applied > 0）；
  // 再跑一次：两边指纹相同，安卓端一条都不用落地 —— 这正说明合并是幂等的，同样算通过。
  const idempotent = reply.applied === 0 && hello.stamp === localStamp
  if (idempotent) {
    console.log('两端数据已完全一致（stamp 相同），本次为幂等空转')
  }
  const ok = reply.received === local.size && (reply.applied > 0 || idempotent)
  console.log(ok ? 'RESULT=PASS' : 'RESULT=FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.log('RESULT=FAIL ' + error.message)
  process.exit(1)
})
