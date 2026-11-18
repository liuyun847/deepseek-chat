/**
 * 生成 sync-server 用的自签 TLS 证书（本地开发 / 局域网自用）。
 *
 * 为什么单独一个脚本
 * ==================
 * Node 内置模块不能直接签发 X.509 证书，这里调用系统 openssl 生成一次；
 * 证书与私钥落在 sync-server/tls/（已在 .gitignore 里），服务启动时用
 * --tls-cert / --tls-key 引用。换 IP、换主机名或证书过期时重新跑一次，
 * 客户端需要重新配对（指纹变了）。
 *
 * 用法
 *   node sync-server/gen-cert.mjs [--dir sync-server/tls] [--force]
 *
 * 依赖：PATH 里有 openssl（Windows 可用 Git for Windows 自带的 openssl）。
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const DIR = path.resolve(
  dirArg === -1 ? path.join(HERE, 'tls') : (args[dirArg + 1] ?? path.join(HERE, 'tls'))
)
const FORCE = args.includes('--force')
const CERT = path.join(DIR, 'cert.pem')
const KEY = path.join(DIR, 'key.pem')

/** 读取已有证书的 SHA-256 指纹并打印 */
const printFingerprint = (certPath) => {
  const cert = new crypto.X509Certificate(fs.readFileSync(certPath))
  console.log('[tls] 证书：%s', certPath)
  console.log('[tls] 私钥：%s', KEY)
  console.log('[tls] SHA-256 指纹：%s', cert.fingerprint256)
  console.log('[tls] 启动：node sync-server/server.mjs --tls-cert %s --tls-key %s', certPath, KEY)
}

if (!FORCE && fs.existsSync(CERT) && fs.existsSync(KEY)) {
  console.log('[tls] 证书已存在，跳过生成（--force 可覆盖）')
  printFingerprint(CERT)
  process.exit(0)
}

const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' })
if (openssl.error || openssl.status !== 0) {
  console.error('[tls] 找不到可用的 openssl。')
  console.error('[tls] Windows 可装 Git for Windows 并把它的 usr\\bin 加进 PATH，或手动生成：')
  console.error(
    '[tls] openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes -keyout key.pem -out cert.pem -subj "/CN=deepseek-chat-sync" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<本机局域网IP>"'
  )
  process.exit(1)
}

/** 把所有非回环 IPv4 地址写进 SAN，手机用局域网 IP 访问时证书才匹配 */
const ips = new Set(['127.0.0.1'])
for (const list of Object.values(os.networkInterfaces())) {
  for (const item of list ?? []) {
    if (item.family === 'IPv4' && !item.internal) {
      ips.add(item.address)
    }
  }
}
const subjectAltName = ['DNS:localhost', ...[...ips].map((ip) => `IP:${ip}`)].join(',')

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
console.log('[tls] 生成自签证书：%s', subjectAltName)
const result = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '3650',
    '-nodes',
    '-keyout',
    KEY,
    '-out',
    CERT,
    '-subj',
    '/CN=deepseek-chat-sync',
    '-addext',
    `subjectAltName=${subjectAltName}`,
  ],
  { stdio: 'inherit' }
)
if (result.status !== 0) {
  console.error('[tls] openssl 生成失败，退出码 %s', result.status)
  process.exit(1)
}
try {
  fs.chmodSync(KEY, 0o600)
} catch {
  // Windows 上 chmod 无实际作用，靠目录 ACL
}
printFingerprint(CERT)
