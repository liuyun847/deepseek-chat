import clsx from 'clsx'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  forget,
  pair,
  refreshPeers,
  runSelfTest,
  setEnabled,
  setupLan,
  syncNow,
  useLan,
  type LanPeerView,
} from '../../services/sync/lan/engine.js'
import { LanCryptoError } from '../../services/sync/lan/crypto.js'
import { Button } from '../base/Button.js'
import settingsStyles from './Settings.module.css'
import styles from './LanSettings.module.css'

/** 设置行：与其它设置页保持一致（左侧说明、右侧操作） */
const Row = ({
  label,
  htmlFor,
  description,
  status,
  action,
  className,
}: {
  label: string
  htmlFor?: string
  description?: string
  status?: { text: string; error?: boolean } | null
  action: ReactNode
  /** 该行专有的排版补充（例如窄屏换行），拼在通用 cell + row 之后 */
  className?: string
}) => (
  <div className={clsx(settingsStyles.cell, settingsStyles.row, className)}>
    <div className={settingsStyles.text}>
      <div className={settingsStyles.label}>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
      </div>
      {status ? (
        <div className={clsx(settingsStyles.description, status.error && settingsStyles.error)}>
          {status.text}
        </div>
      ) : description ? (
        <div className={settingsStyles.description}>{description}</div>
      ) : null}
    </div>
    {action}
  </div>
)

/**
 * 手机直连设置：开关、配对口令、本机信息、发现的设备、自动同步状态。
 *
 * 面板里所有「为什么这样」都写在文案里，用户不需要看文档也能判断失败原因
 * （口令不一致 / 不在同一网段 / 环境不支持 / 对端没响应都有各自的提示）。
 */
export const LanSettings = () => {
  const t = useTranslate()
  const enableId = useId()
  const passId = useId()
  const status = useLan((state) => state.status)
  const enabled = useLan((state) => state.enabled)
  const hasKey = useLan((state) => state.hasKey)
  const pairTag = useLan((state) => state.pairTag)
  const self = useLan((state) => state.self)
  const peers = useLan((state) => state.peers)
  const lastSync = useLan((state) => state.lastSync)
  const busy = useLan((state) => state.busy)
  const testing = useLan((state) => state.testing)
  const selfTest = useLan((state) => state.selfTest)
  const error = useLan((state) => state.error)
  const [passphrase, setPassphrase] = useState('')
  const [pairing, setPairing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // 设置面板可能在页面加载之后才打开：这里补一次「装生命周期 + 刷新设备表」
  useEffect(() => {
    setupLan()
    void refreshPeers()
  }, [])

  const available = status !== 'unsupported'
  const pairedCount = peers.filter((peer) => peer.paired).length

  const statusText = (): { text: string; error?: boolean } => {
    // 只有「环境不支持 / 原生起不来」才算状态错误；同步失败由下面的「上次同步」单独说明，
    // 否则一次同步失败会把状态行长期顶成红色「启动失败」，误导用户以为开关是坏的。
    if (status === 'unsupported') {
      return {
        text: error === 'lanErrorUnsupported' ? t('lanUnsupportedCrypto') : t('lanUnsupportedNative'),
        error: true,
      }
    }
    if (status === 'error') {
      return { text: t('lanStatusError', { message: error ? t(error) : '' }), error: true }
    }
    if (status === 'off') {
      return { text: t('lanStatusOff'), error: false }
    }
    if (status === 'starting') {
      return { text: t('lanStatusStarting'), error: false }
    }
    if (status === 'waiting') {
      return { text: hasKey ? t('lanStatusWaiting') : t('lanNoPassphrase'), error: !hasKey }
    }
    return { text: t('lanStatusRunning'), error: false }
  }

  const lastSyncText = (): string => {
    if (!lastSync) {
      return t('lanNeverSynced')
    }
    const time = new Date(lastSync.at).toLocaleString()
    if (lastSync.ok) {
      return t('lanLastOk', {
        time,
        pushed: lastSync.pushed,
        pulled: lastSync.pulled,
        applied: lastSync.applied,
        peer: lastSync.peer || '-',
      })
    }
    const reason = lastSync.reason
      ? t(lastSync.reason, { message: lastSync.message ?? '' })
      : (lastSync.message ?? '')
    return t('lanLastFailed', { time, message: reason })
  }

  const onToggle = async () => {
    setActionError(null)
    await setEnabled(!enabled)
  }

  const onPair = async () => {
    setActionError(null)
    setPairing(true)
    try {
      await pair(passphrase)
      setPassphrase('')
    } catch (caught) {
      setActionError(
        caught instanceof LanCryptoError && caught.code === 'short'
          ? t('lanErrorShort')
          : t('lanErrorUnsupported')
      )
    } finally {
      setPairing(false)
    }
  }

  const onSelfTest = async () => {
    setActionError(null)
    const result = await runSelfTest()
    if (!result.ok) {
      setActionError(t('lanSelfTestFailed', { message: result.detail }))
    }
  }

  const onForget = () => {
    setActionError(null)
    forget()
  }

  const peerView = (peer: LanPeerView): string => {
    const parts = [peer.host + ':' + peer.port]
    parts.push(peer.lastSyncAt > 0 ? t('lanPeerLastSync', { time: new Date(peer.lastSyncAt).toLocaleString() }) : t('lanPeerNeverSync'))
    return parts.join(' · ')
  }

  return (
    <div className={styles.lan}>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.description}>{t('lanIntro')}</div>
        </div>
      </div>

      <Row
        label={t('lanEnable')}
        htmlFor={enableId}
        description={t('lanEnableDescription')}
        status={statusText()}
        action={
          <Button
            id={enableId}
            variant={enabled ? 'outlined' : 'primary'}
            size="m"
            className={settingsStyles.cellButton}
            aria-pressed={enabled}
            disabled={!available}
            onClick={() => void onToggle()}
          >
            {enabled ? t('lanDisable') : t('lanEnable')}
          </Button>
        }
      />

      <Row
        label={t('lanPassphrase')}
        htmlFor={passId}
        className={settingsStyles.passphraseCell}
        description={t('lanPassphraseDescription')}
        status={
          hasKey ? { text: t('lanPairedHint', { tag: pairTag }) } : { text: t('lanNoPassphrase'), error: true }
        }
        action={
          <div className={styles.field}>
            <input
              id={passId}
              className={styles.input}
              type="password"
              value={passphrase}
              placeholder={t('lanPassphrasePlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setPassphrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && passphrase.trim() && !pairing) {
                  void onPair()
                }
              }}
            />
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              disabled={pairing || passphrase.trim().length === 0}
              onClick={() => void onPair()}
            >
              {t(pairing ? 'lanPairingAction' : 'lanPairAction')}
            </Button>
            {hasKey ? (
              <Button variant="dangerOutlined" size="m" onClick={onForget}>
                {t('lanForgetAction')}
              </Button>
            ) : null}
          </div>
        }
      />

      {self ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>{t('lanSelfTitle')}</div>
          <div className={styles.info}>
            <div>{t('lanSelfDevice')}</div>
            <div className={styles.infoValue}>
              {self.name}（{self.deviceId}）
            </div>
            <div>{t('lanSelfAddress')}</div>
            <div className={styles.infoValue}>
              {self.host}:{self.port}
            </div>
            <div>{t('lanSelfUdpPort')}</div>
            <div className={styles.infoValue}>{self.udpPort}</div>
            <div>{t('lanSelfTag')}</div>
            <div className={styles.infoValue}>{self.pairTag || '-'}</div>
          </div>
        </div>
      ) : null}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t('lanPeersTitle')}</div>
        {peers.length === 0 ? (
          <div className={styles.empty}>{t('lanPeersEmpty')}</div>
        ) : (
          <div className={styles.peers}>
            {peers.map((peer) => (
              <div key={peer.deviceId} className={styles.peer}>
                <div className={styles.peerMain}>
                  <div className={styles.peerName}>{peer.name}</div>
                  <div className={styles.peerMeta}>{peerView(peer)}</div>
                </div>
                <span className={clsx(styles.badge, peer.paired && styles.badgeOk)}>
                  {t(peer.paired ? 'lanPeerPaired' : 'lanPeerUnpaired')}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className={styles.actions}>
          <Button
            variant="outlined"
            size="m"
            disabled={busy || pairedCount === 0}
            onClick={() => void syncNow()}
          >
            {t(busy ? 'lanSyncing' : 'lanSyncNow')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={testing || status === 'off' || !available}
            onClick={() => void onSelfTest()}
          >
            {t(testing ? 'lanSelfTesting' : 'lanSelfTestAction')}
          </Button>
        </div>
      </div>

      <div className={clsx(settingsStyles.cell, styles.summary)}>
        <div className={settingsStyles.description}>{lastSyncText()}</div>
        {selfTest?.ok ? (
          <div className={settingsStyles.description}>
            {t('lanSelfTestOk', { detail: selfTest.detail })}
          </div>
        ) : null}
        {actionError ? (
          <div className={clsx(settingsStyles.description, settingsStyles.error)}>{actionError}</div>
        ) : null}
        <div className={settingsStyles.description}>{t('lanAutoNote')}</div>
      </div>
    </div>
  )
}
