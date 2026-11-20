import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { PairInfo } from '../../services/sync/api.js'
import { pairQrMatrix } from '../../services/sync/pairing.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'
import syncStyles from './SyncSettings.module.css'

/** 每个模块的像素数：实测 2.5 px/模块才到解码边界，4 px 留了约 2 倍余量 */
const MODULE_PX = 4
/** 静区模块数（二维码规范值；小于 4 会让部分扫码器找不到定位图形） */
const QUIET = 4

/** 剩余时间格式化成 mm:ss（负值一律当 0）；塞进 syncPairRemain 的 {time} 里 */
const formatRemain = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
}

/**
 * 「扫码配对」卡片：内联 SVG，不用弹窗。
 *
 * 为什么内联而不是弹窗：手机要对着屏幕扫，弹窗会挡住其它信息，而且 Modal 点遮罩就关，
 * 手一滑二维码就没了。为什么白底黑块：反相（深色底浅模块）会让部分解码器（含 ZXing 的
 * HybridBinarizer 在暗背景上）认不出来，所以底色写死 #fff，深色主题下也一样。
 *
 * 三种状态：
 *   - pair.reachable === false：不画码，改画一条能照做的命令或提示
 *     （默认部署是 loopback；地址有了但服务端没证书时是 no-tls，那一步要先补证书）
 *   - 没过期：画码 + 倒计时 + 复制/重新生成
 *   - 过期：**把 SVG 从 DOM 里撤掉**，换成「已过期 + 重新生成」。
 *     这一步是安全要求而不是美观要求：一张还亮着的过期二维码会被当成仍然有效。
 */
export const PairQr = ({
  pair,
  expiresAt,
  busy,
  onCopy,
  onRefresh,
  copyStatus,
}: {
  /** 服务端给的二维码内容；null 表示老服务端没这个字段（整张卡片就不渲染） */
  pair: PairInfo
  /** 配对码过期时间（毫秒），与 invite.expiresAt 同源 */
  expiresAt: number
  /** 组操作是否进行中（禁用按钮） */
  busy: boolean
  /** 复制配对串 */
  onCopy: () => void
  /** 重新生成（服务端会覆盖旧的 invite，旧码立即作废） */
  onRefresh: () => void
  /** 复制按钮下面的行内提示 */
  copyStatus: string | null
}) => {
  const t = useTranslate()
  const [now, setNow] = useState(() => Date.now())

  // 每秒刷新一次倒计时；expiresAt 变了（重新生成）就重新计时
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])

  const remain = expiresAt - now
  const expired = remain <= 0
  /**
   * 过期后不再算矩阵：SVG 直接从 DOM 里消失，而不是留在那儿只是变灰。
   *
   * 编不出来时（超长 / 库拒绝）**只让二维码变空**，不能把异常抛进渲染：一张画不出来的码
   * 不该让整页设置白屏，剩下的手填码路径仍然可用。
   */
  const { matrix, matrixError } = useMemo(() => {
    if (!pair.uri || expired) {
      return { matrix: null, matrixError: null }
    }
    try {
      return { matrix: pairQrMatrix(pair.uri, QUIET), matrixError: null }
    } catch (error) {
      return { matrix: null, matrixError: error instanceof Error ? error.message : String(error) }
    }
  }, [pair.uri, expired])

  /**
   * 不可达原因 → 一句能照做的话（服务端只给原因，文案放在界面这一层）。
   * no-address 与 no-tls 的处理办法完全不同：前者要指定地址，后者要先生成证书。
   */
  const unreachableText = (reason: PairInfo['reason']): string => {
    switch (reason) {
      case 'no-address':
        return t('syncPairNoAddress')
      case 'no-tls':
        return t('syncPairNoTls')
      default:
        return t('syncPairUnreachable')
    }
  }

  if (!pair.reachable || !pair.uri) {
    return (
      <div className={syncStyles.pairCard} data-ds-pair-card>
        <div className={syncStyles.pairTitle}>{t('syncPairTitle')}</div>
        <div className={syncStyles.pairHint}>{unreachableText(pair.reason)}</div>
        <div className={syncStyles.field}>
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={busy}
            onClick={onRefresh}
          >
            {t('syncPairRefresh')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={syncStyles.pairCard} data-ds-pair-card>
      <div className={syncStyles.pairTitle}>{t('syncPairTitle')}</div>
      <div className={syncStyles.pairHint}>{t('syncPairDescription')}</div>
      <div className={syncStyles.pairQrBox}>
        {matrix ? (
          <svg
            className={syncStyles.pairQr}
            data-ds-pair-qr
            viewBox={'0 0 ' + matrix.size + ' ' + matrix.size}
            width={matrix.size * MODULE_PX}
            height={matrix.size * MODULE_PX}
            shapeRendering="crispEdges"
            role="img"
            aria-label={t('syncPairTitle')}
          >
            <rect width={matrix.size} height={matrix.size} fill="#fff" />
            <path fill="#000" d={matrix.path} />
          </svg>
        ) : (
          <div className={syncStyles.pairExpired} data-ds-pair-expired>
            {matrixError
              ? t('syncPairMatrixFailed', { message: matrixError })
              : t('syncPairExpired')}
          </div>
        )}
      </div>
      <div className={syncStyles.pairMeta}>
        <span className={syncStyles.pairHost}>
          {t('syncPairHost')}{' '}
          <code className={syncStyles.fingerprint} data-ds-pair-host>
            {pair.host ?? ''}
          </code>
        </span>
        <span className={syncStyles.pairCountdown} data-ds-pair-remain>
          {t('syncPairRemain', { time: formatRemain(remain) })}
        </span>
      </div>
      <div className={syncStyles.pairHint}>{t('syncPairFingerprintNote')}</div>
      <div className={syncStyles.field}>
        <Button
          size="m"
          className={styles.cellButton}
          data-ds-pair-copy
          onClick={onCopy}
        >
          {t('syncPairCopy')}
        </Button>
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          data-ds-pair-refresh
          disabled={busy}
          onClick={onRefresh}
        >
          {t('syncPairRefresh')}
        </Button>
      </div>
      {copyStatus ? <div className={syncStyles.pairHint}>{copyStatus}</div> : null}
    </div>
  )
}
