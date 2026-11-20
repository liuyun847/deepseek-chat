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
  type PairInfo,
} from '../../services/sync/api.js'
import type { ParsedPair } from '../../services/sync/pairing.js'
import {
  isCertFingerprint,
  readSyncTlsPin,
  syncTlsPinAvailable,
  writeSyncTlsPin,
} from '../../services/sync/tls.js'
import { copyText } from '../../utils/clipboard.js'
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
import { PairQr } from './PairQr.js'
import { PairScan } from './PairScan.js'
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
  className,
}: {
  label: string
  htmlFor?: string
  description?: string
  status?: Status
  action: ReactNode
  className?: string
}) => (
  <div className={clsx(styles.cell, styles.row, className)}>
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
  /** 二维码内容：服务端在 create/invite 的响应里给，跟着 invite 一起生灭 */
  const [pair, setPair] = useState<PairInfo | null>(null)
  /** 复制配对串的行内提示 */
  const [pairCopyStatus, setPairCopyStatus] = useState<string | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupStatus, setGroupStatus] = useState<Status>(null)
  const [hostTarget, setHostTarget] = useState('')
  /** 服务端自报的证书指纹；HTTP 模式或还没连上时为 null */
  const [serverFingerprint, setServerFingerprint] = useState<string | null>(null)
  /** 本机（安卓壳）已固定的指纹；浏览器里恒为空串 */
  const [pinnedFingerprint, setPinnedFingerprint] = useState(() => readSyncTlsPin())
  const [fingerprintInput, setFingerprintInput] = useState('')
  const [fingerprintStatus, setFingerprintStatus] = useState<Status>(null)
  /** 本环境能否把指纹固定到原生层：只有 APK 里有这座桥 */
  const pinSupported = syncTlsPinAvailable()

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
  /**
   * 要连的是 HTTPS、本机是安卓壳、但还没固定证书指纹。
   * 这种情况下 WebView 必然 cancel 自签证书，请求会以「连不上」的形式失败 ——
   * 与其让用户对着「连不上」猜，不如所有连线动作一律先给一句能照做的提示（见页面上的指纹行）。
   */
  const tlsPinBlocked =
    (effectiveServer ?? '').startsWith('https://') && pinSupported && !pinnedFingerprint

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
    if (tlsPinBlocked) {
      setGroupStatus({ text: t('syncErrorTlsPinMissing'), error: true })
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
      setPair(result.pair)
      setPairCopyStatus(null)
      // 配对流程携带指纹：服务端在配对码响应里给了一份，界面直接显示（HTTP 模式为 null）
      setServerFingerprint(result.certFingerprint)
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
    if (tlsPinBlocked) {
      setGroupStatus({ text: t('syncErrorTlsPinMissing'), error: true })
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
    if (tlsPinBlocked) {
      setGroupStatus({ text: t('syncErrorTlsPinMissing'), error: true })
      return
    }
    setGroupBusy(true)
    setGroupStatus(null)
    try {
      const result = await createInvite(effectiveServer, groupToken)
      setInvite(result.invite)
      setPair(result.pair)
      setPairCopyStatus(null)
      setServerFingerprint(result.certFingerprint)
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
    setPair(null)
    setPairCopyStatus(null)
    setGroupStatus(null)
  }

  /** 把指纹固定到本机（写进原生 SharedPreferences；浏览器里静默跳过） */
  const pinFingerprint = (value: string) => {
    // 没有桥（浏览器里）时按钮本来就不渲染，这里再兜一层：给「浏览器没有固定能力」而不是格式错误
    if (!pinSupported) {
      setFingerprintStatus({ text: t('syncTlsBrowserHint') })
      return false
    }
    if (!writeSyncTlsPin(value)) {
      setFingerprintStatus({ text: t('syncTlsPinInvalid'), error: true })
      return false
    }
    setPinnedFingerprint(readSyncTlsPin())
    setFingerprintStatus({ text: t('syncTlsPinSaved') })
    return true
  }

  /** 手动粘贴指纹保存；清空输入框即清除固定 */
  const onSaveFingerprint = () => {
    if (!isCertFingerprint(fingerprintInput)) {
      setFingerprintStatus({ text: t('syncTlsPinInvalid'), error: true })
      return
    }
    if (pinFingerprint(fingerprintInput)) {
      setFingerprintInput('')
    }
  }

  const onClearFingerprint = () => {
    pinFingerprint('')
  }

  /** 复制服务端上报的指纹（没有时退回复制本机已固定的那份） */
  const onCopyFingerprint = () => {
    const value = serverFingerprint ?? pinnedFingerprint
    if (!value) {
      setFingerprintStatus({ text: t('syncTlsCopyEmpty'), error: true })
      return
    }
    void copyText(value).then((ok) => {
      setFingerprintStatus({
        text: ok ? t('syncTlsCopied') : t('syncTlsCopyFailed'),
        error: !ok,
      })
    })
  }

  /**
   * 复制配对串（整条 deepseek-sync://…）。
   * 有它的理由：给没有摄像头的设备、给远程协助（把串发给对方）、以及让人能直接看一眼。
   * 用的是 copyText（带 execCommand 兜底，正是为「手机通过局域网 HTTP 访问」准备的）。
   */
  const onCopyPair = () => {
    const uri = pair?.uri
    if (!uri) {
      setPairCopyStatus(t('syncPairCopyFailed'))
      return
    }
    void copyText(uri).then((ok) => {
      setPairCopyStatus(ok ? t('syncPairCopied') : t('syncPairCopyFailed'))
    })
  }

  /**
   * 扫码/粘贴串确认后的入组：回填地址与配对码 → 固定指纹 → joinGroup → 保存组。
   *
   * **顺序是硬要求**：先 writeSyncTlsPin 再 joinGroup。WebView 在 TLS 握手阶段就拒自签证书
   * （MainActivity.onReceivedSslError 没有 pin 就 cancel），不是应用层 401 —— 反过来的表现是
   * 「第一下必然失败、第二下就好了」，这种偶发最难查（设计 6.2）。
   *
   * @param parsed 已解析的配对串字段（解析在这一侧做，原生只回原始串）
   * @throws SyncError 等异常原样抛给 PairScan 显示（不吞）
   */
  const onPair = async (parsed: ParsedPair) => {
    // ① 先写证书指纹：WebView 在 TLS 握手阶段就拒自签证书，写晚了第一下必然失败（见设计 6.2）
    if (parsed.fingerprint && pinSupported && !writeSyncTlsPin(parsed.fingerprint)) {
      throw new Error(t('syncTlsPinInvalid'))
    }
    setSyncDeviceName(deviceName)
    setJoinCode(parsed.code)
    if (parsed.fingerprint) {
      setServerFingerprint(parsed.fingerprint)
      setPinnedFingerprint(readSyncTlsPin())
    }
    // ② 再入组（用串里给的地址，不依赖「服务地址」输入框——那个框此刻还没回填）
    const result = await joinGroup(parsed.serverUrl, {
      code: parsed.code,
      device: syncDeviceId,
      name: deviceName,
      canHost: true,
    })
    saveSyncGroup(result.group, result.deviceToken)
    setGroup(result.group)
    // ③ 成功后才回填服务地址：setServer 会立刻触发「按地址拉组信息」那个 effect，
    //    在加入成功之前回填的话，界面会先切到「已加入」的组面板，把正在配对的卡片撤掉 ——
    //    实测就卡在「点了配对没反应」（卡被卸载、按钮消失、请求还在路上）
    setSyncServerUrl(parsed.serverUrl)
    setServer(parsed.serverUrl)
    setInvite(null)
    setPair(null)
    setJoinCode('')
    setGroupStatus({ text: t('syncGroupJoined') })
  }

  const onTest = async () => {
    commit()
    setTestStatus(null)
    setActionStatus(null)
    try {
      const health = await testConnection()
      // 服务端自报的指纹：提前读回来，用户就不必去电脑上抄一遍
      setServerFingerprint(health.certFingerprint)
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
        className={syncStyles.groupRow}
        label={t('syncTlsLabel')}
        description={t('syncTlsDescription')}
        status={
          fingerprintStatus ??
          (tlsPinBlocked ? { text: t('syncTlsPinMissingHint'), error: true } : null)
        }
        action={
          <div className={syncStyles.groupPanel}>
            <div className={syncStyles.field}>
              <span className={syncStyles.fingerprintLabel}>{t('syncTlsServerFingerprint')}</span>
              <code className={syncStyles.fingerprint} data-ds-fingerprint>
                {serverFingerprint ?? t('syncTlsServerFingerprintUnknown')}
              </code>
              <Button
                variant="outlined"
                size="m"
                className={styles.cellButton}
                disabled={!serverFingerprint && !pinnedFingerprint}
                onClick={onCopyFingerprint}
              >
                {t('syncTlsCopy')}
              </Button>
            </div>
            {pinSupported ? (
              <>
                <div className={syncStyles.field}>
                  <span className={syncStyles.fingerprintLabel}>{t('syncTlsPinned')}</span>
                  <code className={syncStyles.fingerprint} data-ds-pin>
                    {pinnedFingerprint || t('syncTlsPinnedNone')}
                  </code>
                  {pinnedFingerprint ? (
                    <Button
                      variant="outlined"
                      size="m"
                      className={styles.cellButton}
                      onClick={onClearFingerprint}
                    >
                      {t('syncTlsPinClear')}
                    </Button>
                  ) : null}
                </div>
                <div className={syncStyles.field}>
                  <input
                    className={syncStyles.input}
                    value={fingerprintInput}
                    placeholder={t('syncTlsPinPlaceholder')}
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={80}
                    onChange={(event) => setFingerprintInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onSaveFingerprint()
                      }
                    }}
                  />
                  <Button
                    size="m"
                    className={styles.cellButton}
                    disabled={!fingerprintInput.trim()}
                    onClick={onSaveFingerprint}
                  >
                    {t('syncTlsPinSave')}
                  </Button>
                  <Button
                    variant="outlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={!serverFingerprint || serverFingerprint === pinnedFingerprint}
                    onClick={() => {
                      if (serverFingerprint) {
                        pinFingerprint(serverFingerprint)
                      }
                    }}
                  >
                    {t('syncTlsPinUseServer')}
                  </Button>
                </div>
              </>
            ) : (
              <div className={syncStyles.hint}>{t('syncTlsBrowserHint')}</div>
            )}
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
        className={syncStyles.groupRow}
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
              {invite && pair ? (
                <PairQr
                  pair={pair}
                  expiresAt={invite.expiresAt}
                  busy={groupBusy}
                  onCopy={onCopyPair}
                  onRefresh={() => void onInvite()}
                  copyStatus={pairCopyStatus}
                />
              ) : null}
              {invite ? (
                <div className={syncStyles.invite}>
                  {t('syncGroupInviteHint', {
                    code: invite.code,
                    time: new Date(invite.expiresAt).toLocaleTimeString(),
                  })}
                  {serverFingerprint ? (
                    <div className={syncStyles.inviteFingerprint}>
                      {t('syncGroupInviteFingerprint', { fingerprint: serverFingerprint })}
                    </div>
                  ) : null}
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
              {/* 扫码/粘贴配对串就放在建组与手填码这一行上面：它是「被邀请的那一端」的入口，
                  与右边电脑侧的二维码卡片正好是同一件事的两面 */}
              <PairScan
                pinSupported={pinSupported}
                describe={describe}
                busy={groupBusy}
                onPair={onPair}
              />
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

