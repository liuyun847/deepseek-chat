/**
 * 命令行参数、默认值与「本机设备身份」。
 *
 * 参数一览（与 --help 的输出必须一致）：
 *   --port <n>         TCP 监听端口，0 = 让系统分随机端口（默认 0，与手机端一致）
 *   --passphrase <p>   口令，必填，≥8 位；也可用环境变量 LAN_PASSPHRASE
 *   --name <s>         设备名（默认取主机名），只用于展示与广播
 *   --data <file>      数据文件（默认 ../sync-server/data/sync-data.json，与 7788 同一份）
 *   --iface <addr>     多网卡时指定用哪块网卡发广播（可写网卡地址或该网段的广播地址）
 *   --udp-port <n>     发现端口（默认 47823，与手机端必须一致）
 *   --device <id>      设备 id（默认读 logs/device.json，没有就生成一次）
 *   --log-dir <dir>    日志目录（默认本目录下的 logs）
 *
 * 为什么设备 id 要落盘：它是冲突判定（updatedAt 撞车时的 tie-break）的依据，
 * 每次启动换一个会让两端对「谁更新」的判断摇摆，历史记录也会被当成另一台设备的。
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 口令最短长度：与 src/services/sync/lan/crypto.ts 的 MIN_PASSPHRASE_LENGTH 一致 */
export const MIN_PASSPHRASE_LENGTH = 8

/** 发现端口：与 android/java/ds/app/LanLink.java 的 DISCOVERY_PORT 一致 */
export const DEFAULT_UDP_PORT = 47823

/** 配置错误：调用方打印消息后以退出码 2 结束，不抛栈 */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** 用法文本（--help 与参数错误时都打这一份） */
export const usageText = () => [
  '用法: node lan-peer/peer.mjs --passphrase <口令> [选项]',
  '',
  '  --passphrase <口令>  必填，至少 8 位；也可用环境变量 LAN_PASSPHRASE',
  '  --port <端口>        TCP 监听端口，默认 0（系统随机分配，随广播告知对端）',
  '  --name <名称>        设备名，默认取主机名',
  '  --data <文件>        数据文件，默认 sync-server/data/sync-data.json（与 7788 共用）',
  '  --iface <地址>       多网卡时指定广播网卡：网卡地址或该网段广播地址',
  '  --udp-port <端口>    发现端口，默认 47823（必须与手机端一致）',
  '  --device <设备 id>   设备 id，默认读 lan-peer/logs/device.json（首次运行生成）',
  '  --log-dir <目录>     日志目录，默认 lan-peer/logs',
  '  --help               打印本说明',
  '',
  '例: node lan-peer/peer.mjs --passphrase my-secret-1',
].join('\n')

/**
 * 解析 --key value / --flag 形式的参数（与 sync-server/server.mjs 同一套写法）。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {Record<string, string|true>} 键值对象；纯开关类参数值为 true
 */
export const parseArgs = (argv) => {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    const value = next === undefined || next.startsWith('--') ? true : next
    if (value !== true) {
      index += 1
    }
    out[key] = value
  }
  return out
}

/**
 * 把一段文本解析成端口号。
 *
 * @param {unknown} value 原始值（可能是 undefined）
 * @param {number} fallback 缺省值
 * @param {string} label 出错信息里的字段名
 * @returns {number} 0..65535 的整数
 * @throws {ConfigError} 不是整数或越界
 */
const portOf = (value, fallback, label) => {
  if (value === undefined || value === true || value === '') {
    return fallback
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(label + ' 不是合法端口: ' + String(value))
  }
  return port
}

/**
 * 读本机设备 id：优先命令行，其次 device.json，都没有就生成并落盘。
 *
 * @param {{ dir: string, override?: string, log: object }} options
 * @returns {Promise<{ deviceId: string, fresh: boolean }>}
 * @sideeffect 首次运行会写 device.json
 */
export const resolveDeviceId = async (options) => {
  const override = typeof options.override === 'string' ? options.override.trim() : ''
  if (override) {
    return { deviceId: override, fresh: false }
  }
  const file = path.join(options.dir, 'device.json')
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    const saved = typeof parsed?.deviceId === 'string' ? parsed.deviceId.trim() : ''
    if (saved) {
      return { deviceId: saved, fresh: false }
    }
  } catch (error) {
    // 文件不存在或坏了：下面重新生成
  }
  // 前缀 pc- 是刻意的：手机端设备 id 是 dev-xxxx，字典序 dev- < pc-，
  // 于是「deviceId 小者发起」这条规则恰好让手机端负责主动同步、电脑端只应答 + ping 催拉。
  const deviceId = 'pc-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  try {
    await fsp.mkdir(options.dir, { recursive: true })
    await fsp.writeFile(file, JSON.stringify({ deviceId, createdAt: Date.now() }, null, 2) + '\n', 'utf8')
  } catch (error) {
    options.log?.warn('设备 id 落盘失败（本次仍可用，但下次重启会换一个新的）: ' + error.message)
  }
  return { deviceId, fresh: true }
}

/**
 * 汇总配置：参数 → 默认值 → 校验。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @param {{ rootDir: string, env: Record<string,string|undefined>, log?: object }} context
 *   rootDir 是 lan-peer 目录，用于算默认数据文件与日志目录
 * @returns {Promise<object>} 规范化后的配置
 * @throws {ConfigError} --help 之外的任何非法输入
 */
export const resolveConfig = async (argv, context) => {
  const args = parseArgs(argv)
  if (args.help) {
    return { help: true }
  }
  const env = context.env || {}
  const rawPassphrase = typeof args.passphrase === 'string' ? args.passphrase : env.LAN_PASSPHRASE
  const passphrase = (rawPassphrase || '').trim()
  if (!passphrase) {
    throw new ConfigError('缺少口令：用 --passphrase <口令> 或环境变量 LAN_PASSPHRASE 提供')
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ConfigError('口令太短：至少 ' + MIN_PASSPHRASE_LENGTH + ' 位（太短挡不住离线字典）')
  }
  const logDir = path.resolve(typeof args['log-dir'] === 'string' ? args['log-dir'] : path.join(context.rootDir, 'logs'))
  const dataFile = path.resolve(
    typeof args.data === 'string'
      ? args.data
      : (env.LAN_DATA || path.join(context.rootDir, '..', 'sync-server', 'data', 'sync-data.json'))
  )
  const hostName = (os.hostname() || 'pc').split('.')[0]
  const name = (typeof args.name === 'string' ? args.name : (env.LAN_NAME || hostName)).trim()
  const device = await resolveDeviceId({
    dir: logDir,
    override: typeof args.device === 'string' ? args.device : undefined,
    log: context.log,
  })
  return {
    help: false,
    passphrase,
    port: portOf(args.port, 0, '--port'),
    udpPort: portOf(args['udp-port'], DEFAULT_UDP_PORT, '--udp-port'),
    name: name || hostName,
    dataFile,
    logDir,
    iface: typeof args.iface === 'string' ? args.iface.trim() : '',
    deviceId: device.deviceId,
    deviceFresh: device.fresh,
    rootDir: context.rootDir,
  }
}
