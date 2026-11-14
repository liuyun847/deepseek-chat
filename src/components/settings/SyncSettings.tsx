import clsx from 'clsx'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { setSyncDeviceName, setSyncServerUrl, useSettings } from '../../services/settings.js'
import { SyncError } from '../../services/sync/api.js'
import {
  prepareFirstSync,
  refreshLastSync,
  runSync,
  testConnection,
  useSync,
  type FirstSyncPreview,
} from '../../services/sync/engine.js'
import type { LastSyncInfo } from '../../services/sync/snapshots.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './Settings.module.css'
import syncStyles from './SyncSettings.module.css'

/** 一行提示：普通说明或错误（红色） */
type Status = { text: string; error?: boolean } | null

/** 设置行：左侧label与说明，右侧操作区，与其它设置页保持一致 */
const Row = ({
  label,
  htmlFor,
  description,
  status,
  action,
}: {
  label: string
  htmlFor?: string
  description?: string
  status?: Status
  action: ReactNode
}) => (
  <div className={clsx(styles.cell, styles.row)}>
    <div className={styles.text}>
      <div className={styles.label}>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
      </div>
      {status ? (
        <div className={clsx(styles.description, status.error && styles.error)}>{status.text}</div>
      ) : description ? (
        <div className={styles.description}>{description}</div>
      ) : null}
    </div>
    {action}
  </div>
)

/** 把异常翻译成当前语言的提示；SyncError 用它的文案 key，其它异常用原文 */
const useErrorText = () => {
  const t = useTranslate()
  return (error: unknown): string =>
    error instanceof SyncError
      ? t(error.key, { message: error.detail ?? '' })
      : error instanceof Error
        ? error.message
        : String(error)
}

/** 上次同步结果的一行文字 */
const useLastSyncText = (info: LastSyncInfo | null): string => {
  const t = useTranslate()
  if (!info) {
    return t('syncNever')
  }
  const time = new Date(info.at).toLocaleString()
  if (info.ok) {
    return t('syncLastOk', {
      time,
      pushed: info.pushed,
      pulled: info.pulled,
      applied: info.applied,
    })
  }
  const reason = info.reason
    ? t(info.reason, { message: info.message ?? '' })
    : (info.message ?? '')
  return t('syncLastFailed', { time, message: reason })
}

/**
 * 多端同步设置：服务地址、设备名、测试连接、立即同步、上次同步结果。
 * 首次同步（本机从没同步过且远端已有记录）先弹确认，写清是「逐条合并」而不是整库覆盖。
 */
export const SyncSettings = () => {
  const t = useTranslate()
  const describe = useErrorText()
  const serverId = useId()
  const deviceId = useId()
  const busy = useSync((state) => state.busy)
  const last = useSync((state) => state.last)
  const streaming = useChatStore((state) => Object.keys(state.streaming).length > 0)
  const importing = useChatStore((state) => state.importingHistory)
  const [server, setServer] = useState(() => useSettings.getState().syncServerUrl)
  const [deviceName, setDeviceName] = useState(() => useSettings.getState().syncDeviceName)
  const [testStatus, setTestStatus] = useState<Status>(null)
  const [actionStatus, setActionStatus] = useState<Status>(null)
  const [preview, setPreview] = useState<FirstSyncPreview | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    void refreshLastSync()
  }, [])

  const commit = () => {
    setSyncServerUrl(server)
    setSyncDeviceName(deviceName)
  }

  const disabledReason = importing
    ? t('syncErrorImporting')
    : streaming
      ? t('syncErrorStreaming')
      : server.trim()
        ? null
        : t('syncNeedsServer')
  const disabled = disabledReason !== null || busy !== null || working
  const lastText = useLastSyncText(last)

  const onTest = async () => {
    commit()
    setTestStatus(null)
    setActionStatus(null)
    try {
      const health = await testConnection()
      setTestStatus({
        text: t('syncTestOk', {
          name: health.name,
          sessions: health.sessions,
          messages: health.messages,
        }),
      })
    } catch (error) {
      setTestStatus({ text: t('syncTestFailed', { message: describe(error) }), error: true })
    }
  }

  /** 真正跑一次同步；失败只更新行内提示，另有一行「上次同步」记录历史 */
  const run = async () => {
    setPreview(null)
    setActionStatus(null)
    setWorking(true)
    try {
      await runSync()
    } catch (error) {
      setActionStatus({ text: describe(error), error: true })
    } finally {
      setWorking(false)
    }
  }

  /** 首次同步先算一遍「远端有什么」，有内容就弹确认，避免用户盲等 */
  const onSync = async () => {
    commit()
    setActionStatus(null)
    setWorking(true)
    try {
      const pending = await prepareFirstSync()
      if (pending) {
        setPreview(pending)
        return
      }
      await runSync()
    } catch (error) {
      setActionStatus({ text: describe(error), error: true })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className={syncStyles.sync}>
      <Row
        label={t('syncServerLabel')}
        htmlFor={serverId}
        description={t('syncServerDescription')}
        status={testStatus}
        action={
          <div className={syncStyles.field}>
            <input
              id={serverId}
              className={syncStyles.input}
              value={server}
              placeholder={t('syncServerPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setServer(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !disabled) {
                  void onTest()
                }
              }}
            />
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={disabled || !server.trim()}
              onClick={() => void onTest()}
            >
              {t(busy === 'test' ? 'syncTesting' : 'syncTest')}
            </Button>
          </div>
        }
      />
      <Row
        label={t('syncDeviceLabel')}
        htmlFor={deviceId}
        description={t('syncDeviceDescription')}
        action={
          <div className={syncStyles.field}>
            <input
              id={deviceId}
              className={syncStyles.input}
              value={deviceName}
              maxLength={40}
              onChange={(event) => setDeviceName(event.target.value)}
              onBlur={commit}
            />
          </div>
        }
      />
      <Row
        label={t('syncNow')}
        description={t('syncDescription')}
        status={actionStatus ?? (disabledReason ? { text: disabledReason } : null)}
        action={
          <Button
            size="m"
            className={styles.cellButton}
            disabled={disabled}
            onClick={() => void onSync()}
          >
            {t(busy === 'sync' || working ? 'syncRunning' : 'syncNow')}
          </Button>
        }
      />
      <div className={clsx(styles.cell, syncStyles.summary)}>
        <div className={styles.description}>{lastText}</div>
        <div className={styles.description}>{t('syncAttachmentsNote')}</div>
      </div>
      {preview ? (
        <FirstSyncConfirm
          preview={preview}
          onCancel={() => setPreview(null)}
          onConfirm={() => void run()}
        />
      ) : null}
    </div>
  )
}

/** 首次同步确认：写清是逐条合并、两边独有的都会保留、删除不会被拉回来 */
const FirstSyncConfirm = ({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: FirstSyncPreview
  onCancel: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('syncFirstConfirmTitle')}
      className={styles.importConfirm}
      onClose={onCancel}
      footer={
        <div className={styles.deleteActions}>
          <Button variant="outlined" autoFocus onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm}>{t('syncFirstConfirmStart')}</Button>
        </div>
      }
    >
      <div className={syncStyles.confirm}>
        <div className={styles.description}>{preview.server}</div>
        <div>
          {t('syncFirstConfirmSummary', {
            remoteSessions: preview.remoteSessions,
            remoteMessages: preview.remoteMessages,
            localSessions: preview.localSessions,
            localMessages: preview.localMessages,
          })}
        </div>
        <div>{t('syncFirstConfirmMerge')}</div>
        <div>{t('syncFirstConfirmTombstone')}</div>
      </div>
    </Modal>
  )
}

