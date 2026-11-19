#!/usr/bin/env node
/**
 * 用 Node 模拟 Android 的「自签证书指纹固定」判据，验证三种情况。
 *
 * 为什么需要这个工具
 * ==================
 * 指纹固定真正的执法点只有一处：android/java/ds/app/MainActivity.java 的
 * onReceivedSslError。它跑在手机里，改一行就要重新出 APK、装包、连 Wi-Fi，无法在
 * CI 或命令行里回归。本工具把那段 Java 的判断逐条搬到 Node，用同一张证书、同一套
 * 字节做等价验证，于是「没 pin 拒、错 pin 拒、对 pin 通」在命令行就能证明。
 *
 * 判据（与 MainActivity.onReceivedSslError 逐条对应）
 * ==================================================
 *   0. 前提：平台（Android 的 WebView / 这里的 Node）**不信任**这张自签证书，
 *      所以走到了 onReceivedSslError。等价写法是 rejectUnauthorized: false ——
 *      不是「关掉校验」，而是「先接上，再由下面这段自己判」。
 *   1. Java:  if (!syncTlsPin.isEmpty())   —— 没有指纹 → 直接 handler.cancel()，不允许 TOFU。
 *      这里：  pin 为空 → 判定 rejected-no-pin，主动断开、不发请求。
 *   2. Java:  digest = SHA-256(cert.getEncoded())，格式化成小写十六进制（%02x × 32）。
 *      这里：  certFingerprintFromDer(socket.getPeerCertificate().raw)，同一份实现
 *              （sync-server/cert-fingerprint.mjs）—— 服务端也是用它算的。
 *   3. Java:  if (syncTlsPin.equals(hex)) handler.proceed(); 否则落到 cancel()。
 *      这里：  pin === actual → 放行并真正发出 HTTP 请求；否则主动断开。
 *
 * 用法
 *   node tools/tls-pin-sim.mjs --url https://127.0.0.1:7798 [--pin <指纹>] [--path /api/health]
 *   node tools/tls-pin-sim.mjs --url https://127.0.0.1:7798 --pin none     # 显式「没有指纹」
 *
 * 退出码（便于 shell 断言）
 *   0  accepted            指纹匹配，请求成功
 *   2  rejected-no-pin     没有指纹 → 拒绝（= Android 的 cancel）
 *   3  rejected-mismatch   指纹不匹配 → 拒绝（= Android 的 cancel）
 *   1  其它失败（连不上、参数错、服务端返回非 200）
 *
 * 只读：不写任何文件，不改服务端状态（默认打 /api/health）。
 */

import https from 'node:https'

import {
  certFingerprintFromDer,
  normalizeCertFingerprint,
} from '../sync-server/cert-fingerprint.mjs'

/** 解析 --key value / --flag 形式的参数（与 sync-server/server.mjs 同款，保持用法一致） */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : next
    if (value !== true) i += 1
    out[key] = value
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help || !args.url) {
  console.log(
    [
      '用法: node tools/tls-pin-sim.mjs --url https://127.0.0.1:7798 [--pin <64 位十六进制>|none] [--path /api/health]',
      '',
      '  --url   同步服务地址（必须 https）',
      '  --pin   要固定的证书指纹；可带冒号/空格。写 none 或不写 = 模拟「手机里没有指纹」',
      '  --path  握手成功后请求的路径，默认 /api/health',
      '',
      '退出码: 0=accept 2=no-pin 3=mismatch 1=其它失败',
    ].join('\n')
  )
  process.exit(args.help ? 0 : 1)
}

const target = new URL(String(args.url))
if (target.protocol !== 'https:') {
  console.error('[sim] --url 必须是 https 地址')
  process.exit(1)
}
const requestPath = String(args.path ?? '/api/health')
// 'none' 与「没写 --pin」都表示手机里没有指纹
const rawPin = args.pin === 'none' || args.pin === undefined ? '' : String(args.pin)
const pin = rawPin ? normalizeCertFingerprint(rawPin) : ''
if (rawPin && !pin) {
  console.error('[sim] --pin 不是合法的 SHA-256 指纹（去掉冒号/空格后应为 64 位十六进制）：' + rawPin)
  process.exit(1)
}

console.log('[sim] 目标 %s%s', target.origin, requestPath)
console.log('[sim] 手机里的指纹：%s', pin || '（没有 → 按 Android 判据应当拒绝）')

/**
 * 判据本体：与 onReceivedSslError 一一对应。
 *
 * @param der 证书 DER（Uint8Array / Buffer）
 * @param pinned 手机里固定的指纹（规范格式；空串表示没有）
 * @returns {{ accepted: boolean, code: string, actual: string }}
 */
function judgeCertificate(der, pinned) {
  const actual = certFingerprintFromDer(der)
  if (!pinned) {
    // Java: if (!syncTlsPin.isEmpty()) { ... } 否则一路落到 handler.cancel()
    return { accepted: false, code: 'rejected-no-pin', actual }
  }
  // Java: if (syncTlsPin.equals(hex.toString())) { handler.proceed(); return; } → handler.cancel()
  return { accepted: pinned === actual, code: pinned === actual ? 'accepted' : 'rejected-mismatch', actual }
}

/**
 * 起一次 HTTPS 请求，在握手完成的那一刻做判定；不通过就立刻断开。
 *
 * @returns {Promise<{ code: string, actual: string, status?: number, body?: string, note?: string }>}
 */
const attempt = () =>
  new Promise((resolve) => {
    let verdict = null
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const req = https.request(
      {
        protocol: 'https:',
        hostname: target.hostname,
        port: target.port || 443,
        path: requestPath,
        method: 'GET',
        // 前提 0：不信任这张自签证书，等价于「Android 走进 onReceivedSslError」
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        agent: false,
        timeout: 8000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          finish({
            code: verdict ? verdict.code : 'accepted',
            actual: verdict ? verdict.actual : '',
            status: res.statusCode,
            body,
          })
        })
      }
    )

    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        const cert = socket.getPeerCertificate(false)
        if (!cert || !cert.raw) {
          finish({ code: 'no-certificate', actual: '' })
          req.destroy()
          return
        }
        verdict = judgeCertificate(cert.raw, pin)
        if (!verdict.accepted) {
          // 判定不通过：断连接，请求一个字节都不发出去（Android 侧是 handler.cancel()）
          req.destroy()
          finish({ code: verdict.code, actual: verdict.actual })
        }
      })
    })

    req.on('timeout', () => {
      finish({ code: 'timeout', actual: '' })
      req.destroy()
    })
    req.on('error', (error) => {
      // 被我们自己 destroy 的请求会带一个 ECONNRESET；有 verdict 时以 verdict 为准
      if (verdict && !verdict.accepted) return
      finish({ code: 'error', actual: '', note: error.message })
    })
    req.end()
  })

const result = await attempt()

console.log('[sim] 服务端实际指纹：%s', result.actual || '（没拿到证书）')
if (result.code === 'accepted') {
  console.log('[sim] 判定：accepted —— 指纹一致，已放行；HTTP %s', result.status)
  if (result.body) console.log('[sim] 响应前 200 字节：%s', result.body.slice(0, 200))
  process.exit(result.status === 200 ? 0 : 1)
}
if (result.code === 'rejected-no-pin') {
  console.log('[sim] 判定：rejected-no-pin —— 没有指纹，按 Android 判据必须 cancel（不允许 TOFU）')
  process.exit(2)
}
if (result.code === 'rejected-mismatch') {
  console.log('[sim] 判定：rejected-mismatch —— 指纹不匹配，按 Android 判据 cancel')
  process.exit(3)
}
console.error('[sim] 失败：%s %s', result.code, result.note ?? '')
process.exit(1)
