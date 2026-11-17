import { useState } from 'react'
import { IconButton } from '../components/base/IconButton.js'
import { IconCloseOutline16 } from '../components/base/icons.js'
import { useTranslate } from '../i18n/index.js'
import { useLocalService } from '../services/localService.js'
import styles from './LocalServiceBanner.module.css'

/**
 * 本机服务的黄色提示条：dist/ 里带着构建期注入的真实 key 时提醒「仅本机自用」。
 *
 * 什么情况下出现：页面由本机服务（local-server/）托管，且服务端 /api/health 报了
 * distHasBakedKey。那意味着当前 dist/ 是用默认 pnpm build 出来的（给 APK 用的那种，
 * key 烘在主包里），当网页产物托管等于把 key 发给每个能打开这个页面的人。
 *
 * 关闭只在本次页面内有效：这是安全提示，刷新后重新出现是刻意的，不做持久化。
 */
export const LocalServiceBanner = () => {
  const t = useTranslate()
  const shown = useLocalService((state) => state.active && state.distHasBakedKey)
  const [closed, setClosed] = useState(false)

  if (!shown || closed) {
    return null
  }

  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>{t('localServiceBakedKeyWarning')}</span>
      <IconButton
        icon={<IconCloseOutline16 />}
        tooltip={t('close')}
        onClick={() => setClosed(true)}
      />
    </div>
  )
}
