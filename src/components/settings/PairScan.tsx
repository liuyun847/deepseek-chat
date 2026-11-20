import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { PairFailure, ParsedPair } from '../../services/sync/pairing.js'
import { parsePairUri } from '../../services/sync/pairing.js'
import { scanAvailable, startScan, type ScanFailureReason } from '../../services/sync/scan.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'
import syncStyles from './SyncSettings.module.css'

/** 一行提示：普通说明或错误（红色），与 SyncSettings 里的 Status 同形 */
type Status = { text: string; error?: boolean } | null

/**
 * 「扫码配对」左侧：扫码按钮 + 粘贴串 + 确认卡（自己这一侧把手机的入组流程走完）。
 *
 * 三段式，不自动提交（设计 6.4）：
 *   1. 扫码或粘贴 → 用唯一解析器 parsePairUri 得到字段；
 *   2. 弹确认卡，把「服务地址 / 配对码 / 证书指纹 / 有效期」摊开让人看一眼；
 *   3. 点「配对并加入」→ 先写证书指纹、再 joinGroup（顺序反了第一下 TLS 必然失败，见设计 6.2）。
 *
 * 为什么解析放在这里而不是原生：解析器只有一份（services/sync/pairing.ts），原生只回原始串。
 * 所以「粘贴串」与「扫码」走的是完全相同的三行代码 —— 这不是巧合，是刻意的。
 */
export const PairScan = ({
  pinSupported,
  describe,
  busy,
  onPair,
  /** 外部（父组件）想清空输入时把 key 换掉即可；默认不传 */
  disabled,
}: {
  /** 本机能否固定证书指纹（只在安卓壳里为 true） */
  pinSupported: boolean
  /** 把异常翻成当前语言（父组件的 useErrorText） */
  describe: (error: unknown) => string
  /** 组操作进行中（禁用按钮） */
  busy: boolean
  /** 用户点了「配对并加入」：写地址 + 写指纹 + joinGroup + 保存组，失败时抛出 */
  onPair: (parsed: ParsedPair) => Promise<void>
  disabled?: boolean
}) => {
  const t = useTranslate()
  const [paste, setPaste] = useState('')
  const [status, setStatus] = useState<Status>(null)
  /** 解析成功、等用户确认的那一组字段 */
  const [confirm, setConfirm] = useState<ParsedPair | null>(null)
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const canScan = scanAvailable()

  /** 解析失败原因 → 一句能照做的话（解析器不带 i18n，映射放在界面这一层） */
  const failureText = (reason: PairFailure): string => {
    switch (reason) {
      case 'length':
        return t('syncPairFailLength')
      case 'scheme':
        return t('syncPairFailScheme')
      case 'version':
        return t('syncPairFailVersion')
      case 'host':
        return t('syncPairFailHost')
      case 'plaintext':
        return t('syncPairFailPlaintext')
      case 'code':
        return t('syncPairFailCode')
      case 'fingerprint':
        return t('syncPairFailFingerprint')
      default:
        return t('syncPairFailScheme')
    }
  }

  /** 原生失败原因 → 一句能照做的话 */
  const scanFailureText = (reason: ScanFailureReason, detail?: string): string => {
    switch (reason) {
      case 'unavailable':
        return t('syncScanUnavailable')
      case 'cancelled':
        return t('syncScanCancelled')
      case 'permission':
        return t('syncScanPermission')
      case 'nocamera':
        return t('syncScanNoCamera')
      case 'timeout':
        return t('syncScanTimeout')
      default:
        return t('syncScanFailed', { message: detail ?? reason })
    }
  }

  /** 扫码与粘贴共用：原始串 → 字段 → 确认卡（失败时只更新一行提示） */
  const accept = (raw: string, source: 'scan' | 'paste') => {
    const text = raw.trim()
    if (!text) {
      setStatus({
        text: source === 'paste' ? t('syncScanPasteEmpty') : t('syncScanTimeout'),
        error: true,
      })
      return
    }
    const parsed = parsePairUri(text)
    if (!parsed.ok) {
      setConfirm(null)
      setStatus({ text: failureText(parsed.reason), error: true })
      return
    }
    setConfirm(parsed)
    // 过期仍允许看字段（可能只是想核对），但不允许直接配对：服务端一定会 403
    setStatus(
      parsed.expired
        ? { text: t('syncPairExpiredConfirm'), error: true }
        : { text: t('syncScanParsed'), error: false }
    )
  }

  const onScan = async () => {
    setStatus(null)
    setConfirm(null)
    setScanning(true)
    try {
      const result = await startScan()
      if (result.ok) {
        accept(result.raw, 'scan')
      } else {
        setStatus({ text: scanFailureText(result.reason, result.detail), error: true })
      }
    } finally {
      setScanning(false)
    }
  }

  const onApply = async () => {
    if (!confirm || confirm.expired) {
      return
    }
    setApplying(true)
    setStatus({ text: t('syncScanConnecting', { host: confirm.host }) })
    try {
      await onPair(confirm)
      setStatus({ text: t('syncScanPaired', { host: confirm.host }) })
      setConfirm(null)
      setPaste('')
    } catch (error) {
      setStatus({ text: describe(error), error: true })
    } finally {
      setApplying(false)
    }
  }

  const locked = busy || applying || scanning || disabled === true
  // 指纹只显示首尾各 8 位：64 位全铺开在窄屏上会撑破整行，而首尾已经够人核对
  const shortFingerprint = confirm?.fingerprint
    ? confirm.fingerprint.slice(0, 8) + '…' + confirm.fingerprint.slice(-8)
    : ''

  return (
    <div className={syncStyles.pairScan} data-ds-pair-scan>
      <div className={syncStyles.pairTitle}>{t('syncScanTitle')}</div>
      <div className={syncStyles.pairHint}>{t('syncScanDescription')}</div>
      <div className={syncStyles.field}>
        {canScan ? (
          <Button
            size="m"
            className={styles.cellButton}
            data-ds-pair-scan-button
            disabled={locked}
            onClick={() => void onScan()}
          >
            {t(scanning ? 'syncScanScanning' : 'syncScanButton')}
          </Button>
        ) : null}
        <input
          className={syncStyles.input}
          data-ds-pair-scan-paste
          value={paste}
          placeholder={t('syncScanPastePlaceholder')}
          spellCheck={false}
          autoComplete="off"
          maxLength={600}
          disabled={locked}
          onChange={(event) => setPaste(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !locked) {
              accept(paste, 'paste')
            }
          }}
        />
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          data-ds-pair-scan-parse
          disabled={locked || !paste.trim()}
          onClick={() => accept(paste, 'paste')}
        >
          {t('syncScanParse')}
        </Button>
      </div>
      {!canScan ? (
        <div className={syncStyles.pairHint}>{t('syncScanUnavailableHint')}</div>
      ) : null}
      {confirm ? (
        <div className={syncStyles.pairScanConfirm} data-ds-pair-scan-confirm>
          <div className={syncStyles.pairTitle}>{t('syncScanConfirmTitle')}</div>
          <div className={syncStyles.pairMeta}>
            <span className={syncStyles.pairHost}>
              {t('syncScanConfirmHost')}{' '}
              <code className={syncStyles.fingerprint} data-ds-pair-scan-host>
                {confirm.serverUrl}
              </code>
            </span>
          </div>
          <div className={syncStyles.pairMeta}>
            <span>
              {t('syncScanConfirmCode')}{' '}
              <code className={syncStyles.fingerprint} data-ds-pair-scan-code>
                {confirm.code}
              </code>
            </span>
          </div>
          <div className={syncStyles.pairMeta}>
            <span>
              {t('syncScanConfirmFingerprint')}{' '}
              <code className={syncStyles.fingerprint} data-ds-pair-scan-fingerprint>
                {confirm.fingerprint
                  ? shortFingerprint
                  : pinSupported
                    ? t('syncPairNoFingerprintPlain')
                    : t('syncPairNoFingerprint')}
              </code>
            </span>
          </div>
          {confirm.expiresAt !== null ? (
            <div className={syncStyles.pairMeta}>
              <span data-ds-pair-scan-expires>
                {t('syncScanConfirmExpires')}{' '}
                {new Date(confirm.expiresAt).toLocaleTimeString()}
              </span>
            </div>
          ) : null}
          <div className={syncStyles.field}>
            <Button
              size="m"
              className={styles.cellButton}
              data-ds-pair-scan-apply
              disabled={locked || confirm.expired}
              onClick={() => void onApply()}
            >
              {t(applying ? 'syncScanApplying' : 'syncScanConfirmPair')}
            </Button>
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              data-ds-pair-scan-cancel
              disabled={locked}
              onClick={() => {
                setConfirm(null)
                setStatus(null)
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {status ? (
        <div
          className={status.error ? syncStyles.pairScanError : syncStyles.pairHint}
          data-ds-pair-scan-status
        >
          {status.text}
        </div>
      ) : null}
    </div>
  )
}
