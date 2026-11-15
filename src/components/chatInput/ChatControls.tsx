import clsx from 'clsx'
import {
  REASONING_EFFORT_OPTIONS,
  setModel,
  setReasoningEffort,
  useSettings,
} from '../../services/settings.js'
import { useModelChoices } from '../../services/models.js'
import { useTranslate } from '../../i18n/index.js'
import { Select } from '../base/Select.js'
import styles from './ChatControls.module.css'

/**
 * 输入区顶部的控制条：模型 + 推理强度。
 *
 * 与设置面板「通用设置」里的两项读写同一份 `useSettings` 状态（`setModel` / `setReasoningEffort`），
 * 所以两处天然双向同步，没有第二份副本需要互相同步。
 * 两个下拉都朝上展开：控制条位于文本框上方，朝下会盖住正在输入的文本。
 */
export const ChatControls = () => {
  const t = useTranslate()
  const { model, options } = useModelChoices()
  const reasoningEffort = useSettings((state) => state.reasoningEffort)
  const thinking = useSettings((state) => state.thinking)

  return (
    <div className={styles.bar}>
      <div className={styles.control}>
        <span className={styles.label}>{t('chatControlsModel')}</span>
        <Select
          className={styles.select}
          compact
          side="top"
          align="start"
          ariaLabel={t('settingsModel')}
          value={model}
          options={options}
          onChange={setModel}
        />
      </div>
      {/* 关闭深度思考后强度不参与请求：置灰不可选，但保留上次选择，重新开启即沿用 */}
      <div
        className={styles.control}
        title={thinking ? undefined : t('settingsReasoningEffortOff')}
      >
        <span className={styles.label}>{t('chatControlsEffort')}</span>
        <Select
          className={clsx(styles.select, styles.effort)}
          compact
          side="top"
          align="start"
          ariaLabel={t('settingsReasoningEffort')}
          value={reasoningEffort}
          disabled={!thinking}
          options={REASONING_EFFORT_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={setReasoningEffort}
        />
      </div>
    </div>
  )
}
