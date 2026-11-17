/**
 * 日志：控制台 + 文件，带大小轮转与敏感串脱敏。
 *
 * 两条硬要求（见任务约束）：
 *   1. 绝不打印口令；口令只出现在配置里，日志里最多出现「已配置」。
 *   2. 绝不打印明文数据；与内容相关的日志只打条数、类型、长度。
 * 脱敏是第二道闸：调用方若误把口令拼进日志，这里逐条替换成 ***。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 单个日志文件的上限；超过就轮转成 peer.log.1（只留一份历史） */
const MAX_BYTES = 2 * 1024 * 1024

/**
 * 造一个 logger。
 *
 * @param {{ dir: string, echo?: boolean, secrets?: string[], file?: string }} options
 *   dir 日志目录；echo 是否同时写控制台（默认 true）；secrets 需要脱敏的串（口令）
 * @returns {{ info: Function, warn: Function, error: Function, file: string }}
 * @sideeffect 建日志目录、按需轮转并追加写文件；控制台输出一行
 */
export const createLogger = (options) => {
  const dir = options.dir
  const echo = options.echo !== false
  const file = options.file || path.join(dir, 'peer.log')
  const secrets = (options.secrets || []).filter((item) => typeof item === 'string' && item.length >= 4)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch (error) {
    // 目录建不了就退化成纯控制台，不能因此起不来
  }

  const redact = (text) => {
    let out = text
    for (const secret of secrets) {
      out = out.split(secret).join('***')
    }
    return out
  }

  /** 本地时间、毫秒精度：排查「广播有没有发出去」要看秒级顺序 */
  const stamp = () => {
    const now = new Date()
    const pad = (value, width) => String(value).padStart(width, '0')
    return now.getFullYear() + '-' + pad(now.getMonth() + 1, 2) + '-' + pad(now.getDate(), 2) +
      ' ' + pad(now.getHours(), 2) + ':' + pad(now.getMinutes(), 2) + ':' + pad(now.getSeconds(), 2) +
      '.' + pad(now.getMilliseconds(), 3)
  }

  const rotateIfNeeded = () => {
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, file + '.1')
      }
    } catch (error) {
      // 文件还不存在（第一次写）属于正常
    }
  }

  const write = (level, message) => {
    const line = '[' + stamp() + '] [' + level + '] ' + redact(String(message))
    if (echo) {
      console.log(line)
    }
    try {
      rotateIfNeeded()
      fs.appendFileSync(file, line + '\n', 'utf8')
    } catch (error) {
      // 写不了日志不影响主流程
    }
  }

  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    file,
  }
}
