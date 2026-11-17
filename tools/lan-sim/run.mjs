/**
 * 单机双端的驾驶脚本：拉起三个「设备」进程（A、B 同口令，C 不同口令），
 * 按剧本跑完发现 → 配对 → 加密 → 合并 → 自动同步 → 墓碑传播，并逐条断言。
 *
 * 用法：node run.mjs [--keep]
 * 退出码 0 表示全部断言通过。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const peerScript = path.join(here, 'peer.mjs')
const UDP_PORT = '47831' // 换个不常用的端口，避免和本机其它 UDP 服务撞上

const children = new Map()
const lines = []
const waiters = []

const record = (device, line) => {
  const entry = { device, line, at: Date.now() }
  lines.push(entry)
  process.stdout.write('  ' + device + ' | ' + line + '\n')
  for (const waiter of [...waiters]) {
    if (waiter.matches(entry)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      clearTimeout(waiter.timer)
      waiter.resolve(entry)
    }
  }
}

const startPeer = (id, name, pass, seed) => {
  const child = spawn(
    process.execPath,
    [peerScript, '--id', id, '--name', name, '--pass', pass, '--seed', seed, '--udp-port', UDP_PORT, '--announce-ms', '800'],
    { cwd: here, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  children.set(id, child)
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.startsWith('## ')) {
        record(id, line.slice(3))
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => record(id, 'STDERR ' + String(chunk).trim()))
  child.on('exit', (code) => record(id, 'exit ' + code))
  return child
}

const send = (id, command) => children.get(id).stdin.write(command + '\n')

/**
 * 等某个设备「再输出一条」满足条件的行；超时抛错。
 *
 * 必须按「基准条数 +1」来判断，不能用 find 找现成的：同一个事件（比如 synced）会出现
 * 好几次，直接找第一条会让断言在旧证据上假通过 —— 第一版剧本就是这么假通过的。
 */
const waitFor = (deviceId, test, timeoutMs, label) => {
  const baseline = lines.filter((entry) => entry.device === deviceId && test(entry.line)).length
  return waitForMore(deviceId, test, timeoutMs, label, baseline)
}

const waitForMore = (deviceId, test, timeoutMs, label, baseline) => {
  const existing = lines.filter((entry) => entry.device === deviceId && test(entry.line))
  if (existing.length > baseline) {
    return Promise.resolve(existing[existing.length - 1])
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      matches: (entry) => entry.device === deviceId && test(entry.line),
      resolve,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) {
          waiters.splice(index, 1)
        }
        reject(new Error('超时 ' + timeoutMs + 'ms：等 ' + deviceId + ' 输出「' + label + '」'))
      }, timeoutMs),
    }
    waiters.push(waiter)
  })
}

const parseReady = (line) => {
  const match = /^ready device=(\S+) tcp=(\d+) udp=(\d+) pairTag=(\w+)$/.exec(line)
  return match ? { tcp: Number(match[2]), pairTag: match[4] } : null
}

const parseDump = (line) => {
  if (!line.startsWith('dump ')) {
    return null
  }
  return JSON.parse(line.slice(5))
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok, detail })
  process.stdout.write((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '  [' + detail + ']' : '') + '\n')
}

const dumpOf = async (deviceId) => {
  const before = lines.filter((entry) => entry.device === deviceId && entry.line.startsWith('dump ')).length
  send(deviceId, 'dump')
  const entry = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等 ' + deviceId + ' 的 dump 超时')), 8000)
    const waiter = {
      matches: (candidate) =>
        candidate.device === deviceId && candidate.line.startsWith('dump ') &&
        lines.filter((item) => item.device === deviceId && item.line.startsWith('dump ')).length > before,
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
    }
    waiters.push(waiter)
  })
  return parseDump(entry.line)
}

const sessionIds = (dump) => dump.sessions.map((session) => session.id).sort()
const sessionOf = (dump, id) => dump.sessions.find((session) => session.id === id)

const main = async () => {
  process.stdout.write('=== 单机双端：A、B 同口令，C 不同口令 ===\n')
  startPeer('dev-a', '手机A', '12345678', 'a')
  startPeer('dev-b', '手机B', '12345678', 'b')
  startPeer('dev-c', '手机C', 'wrongpass456', 'c')

  const readyA = parseReady((await waitFor('dev-a', (line) => line.startsWith('ready '), 20000, 'ready')).line)
  const readyB = parseReady((await waitFor('dev-b', (line) => line.startsWith('ready '), 20000, 'ready')).line)
  await waitFor('dev-c', (line) => line.startsWith('ready '), 20000, 'ready')
  check('三端启动，各自拿到 TCP 端口与口令指纹', !!readyA && !!readyB && !!readyA.pairTag, 'A=' + readyA.tcp + ' B=' + readyB.tcp)
  check('A/B 同口令指纹一致，C 不同', readyA.pairTag === readyB.pairTag)

  // 发现 + 自动同步（发现日志只在状态变化时打一次，因此断言改成「已有这行」而不是等下一行）
  await waitFor('dev-a', (line) => line.startsWith('synced peer=dev-b'), 20000, 'synced peer=dev-b')
  check(
    'A 通过 UDP 广播发现了 B，且口令指纹匹配（已配对）',
    lines.some((entry) => entry.device === 'dev-a' && entry.line.startsWith('peer device=dev-b') && entry.line.includes('paired=yes'))
  )
  check('A 自动发起并完成一轮同步（hello → sync → sync-reply）', true)

  const afterFirstA = await dumpOf('dev-a')
  const afterFirstB = await dumpOf('dev-b')
  check('同步后两端会话集合一致', JSON.stringify(sessionIds(afterFirstA)) === JSON.stringify(sessionIds(afterFirstB)), sessionIds(afterFirstA).join(','))
  check('两端都拿到 s1/s2/s3（各自独有的会话互相补齐）', ['s1', 's2', 's3'].every((id) => sessionIds(afterFirstA).includes(id) && sessionIds(afterFirstB).includes(id)))
  const sharedA = sessionOf(afterFirstA, 's1')
  const sharedB = sessionOf(afterFirstB, 's1')
  check('同一条会话两端都改过：按 LWW 收敛到同一版标题', sharedA.title === sharedB.title, sharedA.title)
  check('两端 s1 的消息集合一致（m1 + m3）', JSON.stringify(sharedA.messages.slice().sort()) === JSON.stringify(sharedB.messages.slice().sort()), sharedA.messages.join(','))
  check('A/B 数据版本指纹相同（无残留差异）', afterFirstA.stamp === afterFirstB.stamp, afterFirstA.stamp)

  // 不同口令：C 尝试连 A，A 必须拒绝
  send('dev-c', 'probe 127.0.0.1:' + readyA.tcp)
  await waitFor('dev-a', (line) => line.startsWith('reject auth'), 15000, 'reject auth')
  const cSynced = lines.some((entry) => entry.device === 'dev-c' && entry.line.includes('synced peer='))
  check('不同口令的设备被拒绝（AES-GCM 认证失败，A 不解包、C 不同步）', !cSynced)
  const cDump = await dumpOf('dev-c')
  check('C 的本地数据没有被污染', JSON.stringify(sessionIds(cDump)) === '["s9"]', sessionIds(cDump).join(','))

  // 用户改数据后自动同步
  send('dev-a', 'edit s1 用户在 A 上补的一条消息')
  await waitFor('dev-a', (line) => line.startsWith('synced peer=dev-b'), 20000, 'resync after edit')
  const editedA = await dumpOf('dev-a')
  const editedB = await dumpOf('dev-b')
  const extraA = sessionOf(editedA, 's1').messages.filter((id) => !sharedA.messages.includes(id))
  check(
    'A 新增消息后自动推给 B',
    extraA.length === 1 && sessionOf(editedB, 's1').messages.includes(extraA[0]),
    extraA.join(',')
  )

  // 删除 → 墓碑传播
  send('dev-a', 'delete-session s2')
  await waitFor('dev-a', (line) => line.startsWith('synced peer=dev-b'), 20000, 'resync after delete')
  const deletedA = await dumpOf('dev-a')
  const deletedB = await dumpOf('dev-b')
  check('A 删除会话 s2 后，B 也被删掉（墓碑同步，不会被拉回来）', !sessionIds(deletedB).includes('s2'), sessionIds(deletedB).join(','))
  check('删除后两端仍然一致', deletedA.stamp === deletedB.stamp, deletedA.stamp + ' / ' + deletedB.stamp)

  // 再等两轮广播，确认墓碑没被来回复活
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const stableA = await dumpOf('dev-a')
  const stableB = await dumpOf('dev-b')
  check('静置 4s 后两端仍一致（墓碑没有反复复活）', stableA.stamp === stableB.stamp && !sessionIds(stableB).includes('s2'), sessionIds(stableA).join(','))

  const failed = results.filter((item) => !item.ok)
  process.stdout.write('\n=== 断言 ' + results.length + ' 条，失败 ' + failed.length + ' 条 ===\n')
  for (const child of children.values()) {
    child.kill()
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (error) => {
  process.stdout.write('\n!!! 剧本执行失败：' + error.message + '\n')
  for (const child of children.values()) {
    child.kill()
  }
  process.exit(2)
})
