import clsx from 'clsx'
import { useId, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  DEFAULT_PROMPT_ID,
  PROMPT_CONTENT_MAX,
  PROMPT_NAME_MAX,
  createSystemPrompt,
  listSystemPrompts,
  removeSystemPrompt,
  selectSystemPrompt,
  updateSystemPrompt,
  useSystemPrompts,
  type SystemPrompt,
} from '../../services/prompts.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconCloseOutline16,
  IconEditOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import styles from './Settings.module.css'

/** 编辑器草稿：id 为 null 表示新建，保存后才写入库 */
type Draft = { id: string | null; name: string; content: string }

/**
 * 系统提示词库：顶部选择生效项，下方列出内置默认项与自定义项。
 * 内置默认项只读（保证「回退默认」始终等于接入提示词库之前的文案），自定义项可编辑、重命名、删除。
 * 切换只改下一次请求的 system，不触碰任何已保存的会话与消息。
 *
 * 列表上方有搜索框：按名称与内容做不区分大小写的实时过滤，只影响列表展示 ——
 * 选中、编辑、删除都按 id 操作，搜索状态下照常可用；「生效的提示词」下拉始终是完整列表，
 * 免得筛掉之后选不到已经生效的那条。
 */
export const SystemPromptSettings = () => {
  const t = useTranslate()
  const prompts = useSystemPrompts((state) => state.prompts)
  const selectedId = useSystemPrompts((state) => state.selectedId)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<SystemPrompt | null>(null)
  const [query, setQuery] = useState('')

  const items = listSystemPrompts(prompts)
  const activeId = selectedId ?? DEFAULT_PROMPT_ID
  const nameOf = (prompt: SystemPrompt) =>
    prompt.id === DEFAULT_PROMPT_ID ? t('systemPromptDefaultName') : prompt.name
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? items.filter(
        (prompt) =>
          nameOf(prompt).toLowerCase().includes(needle) ||
          prompt.content.toLowerCase().includes(needle)
      )
    : items

  const save = () => {
    if (!draft) {
      return
    }
    const name = draft.name.trim()
    const content = draft.content.trim()
    if (!name || !content) {
      return
    }
    if (draft.id) {
      updateSystemPrompt(draft.id, name, content)
    } else {
      createSystemPrompt(name, content)
    }
    setDraft(null)
  }

  return (
    <div className={styles.prompts}>
      <div className={clsx(styles.cell, styles.row, styles.promptActiveCell)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('systemPromptActive')}</div>
          <div className={styles.description}>{t('systemPromptActiveDescription')}</div>
        </div>
        <div className={styles.promptActions}>
          <Select
            ariaLabel={t('systemPromptActive')}
            className={styles.promptSelect}
            value={activeId}
            options={items.map((prompt) => ({ value: prompt.id, label: nameOf(prompt) }))}
            onChange={selectSystemPrompt}
          />
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            onClick={() => setDraft({ id: null, name: '', content: '' })}
          >
            {t('systemPromptNew')}
          </Button>
        </div>
      </div>
      {draft ? (
        <PromptEditor
          draft={draft}
          onChange={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      ) : null}
      <div className={styles.promptSearch}>
        <span className={styles.promptSearchIcon} aria-hidden>
          <IconSearchOutline16 />
        </span>
        <input
          type="text"
          className={styles.promptSearchInput}
          aria-label={t('systemPromptSearchPlaceholder')}
          placeholder={t('systemPromptSearchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className={styles.promptSearchClear}
            aria-label={t('systemPromptSearchClear')}
            onClick={() => setQuery('')}
          >
            <IconCloseOutline16 />
          </button>
        ) : null}
      </div>
      {visible.length === 0 ? (
        <div className={styles.promptEmpty} role="status">
          {t('systemPromptSearchEmpty')}
        </div>
      ) : (
        <ul className={styles.promptList} role="radiogroup">
          {visible.map((prompt) => (
            <li
              key={prompt.id}
              data-prompt-id={prompt.id}
              className={clsx(
                styles.promptItem,
                prompt.id === activeId && styles.promptItemActive
              )}
              role="radio"
              aria-checked={prompt.id === activeId}
              tabIndex={0}
              onClick={() => selectSystemPrompt(prompt.id)}
              onKeyDown={(event) => {
                // 按键事件来自卡片内部的编辑/删除按钮时交给按钮自己处理，避免顺带切换选中
                if (event.target !== event.currentTarget) {
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  // Space 默认会滚动页面，选中由本卡片接管
                  event.preventDefault()
                  selectSystemPrompt(prompt.id)
                }
              }}
            >
              <div className={styles.promptHead}>
                <span className={styles.promptName}>{nameOf(prompt)}</span>
                {prompt.id === DEFAULT_PROMPT_ID ? (
                  <span className={styles.promptBadge}>{t('systemPromptBuiltinBadge')}</span>
                ) : null}
                {prompt.id === activeId ? (
                  <span className={clsx(styles.promptBadge, styles.promptBadgeActive)}>
                    {t('systemPromptSelectedBadge')}
                  </span>
                ) : null}
                {prompt.id === DEFAULT_PROMPT_ID ? null : (
                  <span className={styles.promptItemActions}>
                    <IconButton
                      size="m"
                      icon={<IconEditOutline16 />}
                      tooltip={t('systemPromptEditFor', { name: prompt.name })}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDraft(prompt)
                      }}
                    />
                    <IconButton
                      size="m"
                      icon={<IconTrashOutline16 />}
                      tooltip={t('systemPromptDeleteFor', { name: prompt.name })}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDeleting(prompt)
                      }}
                    />
                  </span>
                )}
              </div>
              <div className={styles.promptPreview}>{prompt.content}</div>
            </li>
          ))}
        </ul>
      )}
      {deleting ? (
        <DeletePromptConfirm
          prompt={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            removeSystemPrompt(deleting.id)
            if (draft?.id === deleting.id) {
              setDraft(null)
            }
            setDeleting(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** 新建与编辑共用：名称为空或内容为空时禁用保存，并提示原因 */
const PromptEditor = ({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft
  onChange: (draft: Draft) => void
  onSave: () => void
  onCancel: () => void
}) => {
  const t = useTranslate()
  const nameId = useId()
  const contentId = useId()
  const valid = draft.name.trim() !== '' && draft.content.trim() !== ''
  return (
    <div className={styles.promptEditor}>
      <div className={styles.promptField}>
        <label className={styles.fieldLabel} htmlFor={nameId}>
          {t('systemPromptName')}
        </label>
        <input
          id={nameId}
          className={styles.fieldInput}
          aria-label={t('systemPromptName')}
          maxLength={PROMPT_NAME_MAX}
          autoFocus
          value={draft.name}
          placeholder={t('systemPromptNamePlaceholder')}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className={styles.promptField}>
        <label className={styles.fieldLabel} htmlFor={contentId}>
          {t('systemPromptContent')}
        </label>
        <textarea
          id={contentId}
          className={styles.fieldTextarea}
          aria-label={t('systemPromptContent')}
          rows={4}
          maxLength={PROMPT_CONTENT_MAX}
          value={draft.content}
          placeholder={t('systemPromptContentPlaceholder')}
          onChange={(event) => onChange({ ...draft, content: event.target.value })}
        />
      </div>
      <div className={styles.promptEditorFooter}>
        {valid ? null : <span className={styles.description}>{t('systemPromptRequired')}</span>}
        <Button variant="outlined" size="m" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button size="m" disabled={!valid} onClick={onSave}>
          {t('systemPromptSave')}
        </Button>
      </div>
    </div>
  )
}

/** 删除确认叠在设置弹窗之上；确认后删库并回退选择，由 store 保证不留下悬空 id */
const DeletePromptConfirm = ({
  prompt,
  onClose,
  onConfirm,
}: {
  prompt: SystemPrompt
  onClose: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('systemPromptDeleteTitle')}
      className={styles.deleteConfirm}
      onClose={onClose}
      footer={
        <div className={styles.deleteActions}>
          <Button variant="outlined" autoFocus onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t('delete')}
          </Button>
        </div>
      }
    >
      <div className={styles.importConfirmText}>
        {t('systemPromptDeleteFor', { name: prompt.name })}
      </div>
      <div className={styles.description}>{t('systemPromptDeleteDescription')}</div>
    </Modal>
  )
}
