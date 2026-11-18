import clsx from 'clsx'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { useLocalService } from '../../services/localService.js'
import {
  clearSyncGroup,
  saveSyncGroup,
  setSyncDeviceName,
  setSyncServerUrl,
  useSettings,
} from '../../services/settings.js'
import {
  createGroup,
  createInvite,
  fetchGroup,
  joinGroup,
  resolveServerUrl,
  revokeDevice,
  sameOriginServer,
  SyncError,
  transferHost,
  type GroupInfo,
  type InviteInfo,
} from '../../services/sync/api.js'
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
import { Select } from '../base/Select.js'
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
 *
 * 地址可以留空：页面由本机服务（local-server/）托管时，留空即走同源反代 /sync/api，
 * 由它转到 127.0.0.1:7788 —— 浏览器零配置就能看到手机同步来的会话。填了地址则按填的连。
 *
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
  // 本页是否由本机服务托管：决定「地址留空」时能不能走同源反代
  const localService = useLocalService((state) => state.active)
  const [server, setServer] = useState(() => useSettings.getState().syncServerUrl)
  const [deviceName, setDeviceName] = useState(() => useSettings.getState().syncDeviceName)
  const [testStatus, setTestStatus] = useState<Status>(null)
  const [actionStatus, setActionStatus] = useState<Status>(null)
  const [preview, setPreview] = useState<FirstSyncPreview | null>(null)
  const [working, setWorking] = useState(false)
  const syncDeviceId = useSettings((state) => state.syncDeviceId)
  const groupId = useSettings((state) => state.syncGroupId)
  const groupToken = useSettings((state) => state.syncGroupToken)
  const groupEpoch = useSettings((state) => state.syncGroupEpoch)
  const [group, setGroup] = useState<GroupInfo | null>(null)
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupStatus, setGroupStatus] = useState<Status>(null)
  const [hostTarget, setHostTarget] = useState('')

  useEffect(() => {
    void refreshLastSync()
  }, [])

  const commit = () => {
    setSyncServerUrl(server)
    setSyncDeviceName(deviceName)
  }

  // 留空时地址由同源反代兜底：只有「既没填、本机服务也不在」才拦着不让点
  const sameOrigin = localService ? sameOriginServer() : null
  const effectiveServer = resolveServerUrl(server, localService)
  const disabledReason = importing
    ? t('syncErrorImporting')
    : streaming
      ? t('syncErrorStreaming')
      : effectiveServer
        ? null
        : t('syncNeedsServer')
  const disabled = disabledReason !== null || busy !== null || working
  const lastText = useLastSyncText(last)

  // 打开设置时读一次服务端的组信息；已加入组但服务端没有组时保持 null，提示重新配对
  useEffect(() => {
    if (!effectiveServer) {
      return
    }
    let cancelled = false
    void fetchGroup(effectiveServer)
      .then((info) => {
        if (!cancelled) {
          setGroup(info)
        }
      })
      .catch(() => {
        // 服务没起来时由「测试连接」给出具体原因，这里不重复报错
      })
    return () => {
      cancelled = true
    }
  }, [effectiveServer, groupId])

  // 默认把「更换主机」的目标选成第一个可当主机的其它设备
  useEffect(() => {
    if (!group) {
      setHostTarget('')
      return
    }
    const candidate = group.devices.find(
      (device) => device.canHost && device.id !== group.hostDeviceId
    )
    setHostTarget(candidate?.id ?? '')
  }, [group])

  const groupError = (error: unknown) => {
    setGroupStatus({ text: describe(error), error: true })
  }

  const onCreateGroup = async () => {
    if (!effectiveServer) {
      return
    }
    commit()
    setGroupBusy(true)
    setGroupStatus(null)
    try {
      const result = await createGroup(effectiveServer, {
        device: syncDeviceId,
        name: deviceName,
        canHost: true,
      })
      saveSyncGroup(result.group, result.deviceToken)
      setGroup(result.group)
      setInvite(result.invite)
      setGroupStatus({ text: t('syncGroupCreated') })
    } catch (error) {
      groupError(error)
    } finally {
      setGroupBusy(false)
    }
  }

  const onJoinGroup = async () => {
    if (!effectiveServer) {
      return
    }
    const code = joinCode.trim().toUpperCase()
    if (!code) {
      return
    }
    commit()
    setGroupBusy(true)
    setGroupStatus(null)
    try {
      const result = await joinGroup(effectiveServer, {
        code,
        device: syncDeviceId,
        name: deviceName,
        canHost: true,
      })
      saveSyncGroup(result.group, result.deviceToken)
      setGroup(result.group)
      setJoinCode('')
      setGroupStatus({ text: t('syncGroupJoined') })
    } catch (error) {
      groupError(error)
    } finally {
      setGroupBusy(false)
    }
  }

  const onInvite = async () => {
    if (!effectiveServer || !groupToken) {
      setGroupStatus({ text: t('syncGroupTokenMissing'), error: true })
      return
    }
    setGroupBusy(true)
    setGroupStatus(null)
    try {
      setInvite(await createInvite(effectiveServer, groupToken))
    } catch (error) {
      groupError(error)
    } finally {
      setGroupBusy(false)
    }
  }

  const onRefreshGroup = async () => {
    if (!effectiveServer) {
      return
    }
    setGroupBusy(true)
    setGroupStatus(null)
    try {
      const info = await fetchGroup(effectiveServer)
      setGroup(info)
      if (info) {
        saveSyncGroup(info)
      }
    } catch (error) {
      groupError(error)
    } finally {
      setGroupBusy(false)
    }
  }

  const onChangeHost = async () => {
    if (!effectiveServer || !groupToken || !hostTarget) {
      return
    }
    setGroupBusy(true)
    setGroupStatus(null)
    try {
      const info = await transferHost(
        effectiveServer,
        groupToken,
        syncDeviceId,
        hostTarget,
        groupEpoch
      )
      saveSyncGroup(info)
      setGroup(info)
      setGroupStatus({ text: t('syncGroupHostChanged') })
    } catch (error) {
      groupError(error)
    } finally {
      setGroupBusy(false)
    }
  }

  const onRevokeGroupDevice = async (target: string) => {
    if (!effectiveServer || !groupToken) {
      return
    }
    setGroupBusy(true)
    setGroupStatus(null)
    try {
      const info = await revokeDevice(effectiveServer, groupToken, target)
      saveSyncGroup(info)
      setGroup(info)
      setGroupStatus({ text: t('syncGroupRevoked') })
    } catch (error) {
      groupError(error)
    } finally {
      setGroupBusy(false)
    }
  }

  const onLeaveGroup = () => {
    clearSyncGroup()
    setGroup(null)
    setInvite(null)
    setGroupStatus(null)
  }

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
          prompts: health.prompts,
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

  const hostName =
    group?.devices.find((device) => device.id === group.hostDeviceId)?.name ?? '—'
  const isHost = group?.hostDeviceId === syncDeviceId
  const hostOptions =
    group?.devices
      .filter((device) => device.canHost && device.id !== group.hostDeviceId)
      .map((device) => ({ value: device.id, label: device.name })) ?? []

  return (
    <div className={syncStyles.sync}>
      <Row
        label={t('syncServerLabel')}
        htmlFor={serverId}
        description={
          server.trim() || !sameOrigin
            ? t('syncServerDescription')
            : t('syncServerSameOrigin', { url: sameOrigin })
        }
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
              disabled={disabled}
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
        label={t('syncGroupLabel')}
        description={
          group ? `${group.groupName} · ${group.groupId}` : t('syncGroupDescription')
        }
        status={
          groupStatus ??
          (groupId && !groupToken
            ? { text: t('syncGroupTokenMissing'), error: true }
            : null)
        }
        action={
          group ? (
            <div className={syncStyles.groupPanel}>
              <div className={syncStyles.groupMeta}>
                <span>
                  {t('syncGroupHost')}: {hostName}
                  {group.hostDeviceId === syncDeviceId ? ` (${t('syncGroupThisDevice')})` : ''}
                </span>
                <span>
                  {t('syncGroupMembers')}: {group.devices.length}
                </span>
              </div>
              <ul className={syncStyles.memberList}>
                {group.devices.map((device) => (
                  <li key={device.id} className={syncStyles.member}>
                    <span className={syncStyles.memberName}>{device.name}</span>
                    {device.id === group.hostDeviceId ? (
                      <span className={syncStyles.badge}>{t('syncGroupHost')}</span>
                    ) : null}
                    {device.id === syncDeviceId ? (
                      <span className={syncStyles.badge}>{t('syncGroupThisDevice')}</span>
                    ) : null}
                    {isHost && device.id !== group.hostDeviceId && device.id !== syncDeviceId ? (
                      <button
                        type="button"
                        className={syncStyles.memberRemove}
                        disabled={groupBusy}
                        onClick={() => void onRevokeGroupDevice(device.id)}
                      >
                        {t('syncGroupRemove')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {invite ? (
                <div className={syncStyles.invite}>
                  {t('syncGroupInviteHint', {
                    code: invite.code,
                    time: new Date(invite.expiresAt).toLocaleTimeString(),
                  })}
                </div>
              ) : null}
              <div className={syncStyles.field}>
                {isHost ? (
                  <Button
                    size="m"
                    className={styles.cellButton}
                    disabled={groupBusy}
                    onClick={() => void onInvite()}
                  >
                    {t('syncGroupInvite')}
                  </Button>
                ) : null}
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={groupBusy}
                  onClick={() => void onRefreshGroup()}
                >
                  {t('syncGroupRefresh')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={groupBusy}
                  onClick={onLeaveGroup}
                >
                  {t('syncGroupLeave')}
                </Button>
              </div>
              <div className={syncStyles.field}>
                <Select
                  ariaLabel={t('syncGroupChangeHost')}
                  value={hostTarget}
                  placeholder={t('syncGroupNoHostTarget')}
                  options={hostOptions}
                  onChange={setHostTarget}
                />
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={!hostTarget || groupBusy}
                  onClick={() => void onChangeHost()}
                >
                  {t('syncGroupChangeHost')}
                </Button>
              </div>
              <div className={syncStyles.hint}>{t('syncGroupChangeHostHint')}</div>
            </div>
          ) : (
            <div className={syncStyles.groupPanel}>
              <div className={syncStyles.field}>
                <Button
                  size="m"
                  className={styles.cellButton}
                  disabled={groupBusy || !effectiveServer}
                  onClick={() => void onCreateGroup()}
                >
                  {t('syncGroupCreate')}
                </Button>
                <input
                  className={syncStyles.input}
                  value={joinCode}
                  placeholder={t('syncGroupJoinPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={12}
                  onChange={(event) => setJoinCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !groupBusy) {
                      void onJoinGroup()
                    }
                  }}
                />
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={!joinCode.trim() || groupBusy || !effectiveServer}
                  onClick={() => void onJoinGroup()}
                >
                  {t('syncGroupJoin')}
                </Button>
              </div>
            </div>
          )
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

