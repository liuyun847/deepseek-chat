/**
 * 自签证书指纹：全仓唯一实现，服务端、发证脚本与联调工具都从这里取。
 *
 * 为什么单独一个文件
 * ==================
 * 指纹要在四处出现：服务启动日志、`GET /api/health` 与 `GET /`、配对码响应
 * （`POST /api/group/{create,invite}`）、以及 Android 的 `MainActivity.onReceivedSslError`
 * 校验。只要有一处算法或写法不同（大小写、冒号、BASE64、SHA-1 与 SHA-256），
 * 手机就会「永远差一位」而连不上，且错误只表现为一句含糊的 TLS 失败。
 * 因此这里把「算什么」和「长什么样」一次性钉死：
 *
 *   算法：X.509 证书 DER 的整体 SHA-256（即 OpenSSL 的 `-fingerprint -sha256`）
 *   格式：64 位小写十六进制、无分隔符（例：`3f2a...`，共 64 个字符）
 *
 * 这个格式与 Android 侧的判据逐字节等价：`Bridge.setSyncTlsPin` 会去掉冒号/空格并转小写后
 * 按 `[0-9a-f]{64}` 校验、`onReceivedSslError` 把 `cert.getEncoded()` 的 SHA-256 也格式化成
 * 同样的小写十六进制再比对 —— 见 android/java/ds/app/MainActivity.java。
 *
 * 只用 node: 内置模块，保持「零第三方依赖」。
 */

import crypto from 'node:crypto'

/** 规范格式的长度：SHA-256 是 32 字节，每字节两位十六进制 */
export const CERT_FINGERPRINT_LENGTH = 64

/** 规范格式本身（小写十六进制、无分隔符） */
export const CERT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

/**
 * 把任意写法的指纹收敛成规范格式。
 *
 * 接受 OpenSSL 的默认写法（`AB:CD:...`，大写带冒号）、空格分组的复制结果、全小写无分隔；
 * 其余字符（含多余的引号、前缀 `sha256=` 之类）一并丢掉再看结果对不对。
 *
 * @param value 用户/日志/接口里拿到的任意指纹写法
 * @returns 规范格式的 64 位小写十六进制；不合法时返回空串（调用方据此判「没给指纹」）
 */
export function normalizeCertFingerprint(value) {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/[^0-9a-zA-Z]/g, '').toLowerCase()
  return CERT_FINGERPRINT_PATTERN.test(compact) ? compact : ''
}

/**
 * 是否是一个可用的规范指纹。
 * @param value 任意值
 * @returns 收敛成规范格式后是否合法
 */
export function isCertFingerprint(value) {
  return normalizeCertFingerprint(value) !== ''
}

/**
 * 证书 DER → 规范指纹。
 * @param der Buffer/Uint8Array：证书的 DER 编码（不含 PEM 头尾）
 * @returns 64 位小写十六进制
 */
export function certFingerprintFromDer(der) {
  return crypto.createHash('sha256').update(der).digest('hex')
}

/**
 * PEM（或 DER）证书 → 规范指纹。
 *
 * 用 `X509Certificate.raw`（DER）而不是 `fingerprint256`：后者是 `AB:CD:...` 的大写
 * 冒号格式，直接转小写会留下冒号，与 Android 的判据对不上。
 *
 * @param pem 证书内容：PEM 文本或 DER Buffer
 * @returns 64 位小写十六进制
 * @throws 内容不是合法 X.509 证书时抛错（调用方决定是退出还是忽略）
 */
export function certFingerprintFromPem(pem) {
  const cert = new crypto.X509Certificate(pem)
  return certFingerprintFromDer(cert.raw)
}
