import { create } from 'zustand'
import { createId } from '../utils/id.js'

/** 内置默认提示词的 id：不可编辑、不可删除，展示名由界面按语言翻译 */
export const DEFAULT_PROMPT_ID = 'default'

/**
 * 内置默认提示词的内容，也就是接入提示词库之前写死的文案（`store.ts` 的 `SYSTEM_PROMPT`）。
 * 没有选中任何自定义项、或选中项已被删除时发送这条。
 */
export const DEFAULT_PROMPT_CONTENT = '该助手为DeepSeek，由深度求索公司创造。'

/** 名称与内容长度上限：提示词是逐字发送的文本，过长会白占 token 并撑大 localStorage */
export const PROMPT_NAME_MAX = 60
export const PROMPT_CONTENT_MAX = 4000

/** 用户自定义的系统提示词；内置默认项不落存储，始终由代码提供 */
export type SystemPrompt = {
  id: string
  name: string
  content: string
}

/** 存储键沿用 `settings.ts` 的 `chat-demo:` 前缀；提示词库是纯文本小数据，没必要进 IndexedDB */
const KEYS = {
  /** 自定义提示词列表（JSON 数组），空列表时删除该键 */
  prompts: 'chat-demo:system-prompts',
  /** 当前生效的提示词 id；用内置默认项时删除该键 */
  selected: 'chat-demo:system-prompt-selected',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 逐条校验存档：只保留三个字段都是非空字符串的项，并截断到长度上限 */
const normalizePrompt = (value: unknown): SystemPrompt | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { id, name, content } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string' || typeof content !== 'string') {
    return null
  }
  const trimmedName = name.trim().slice(0, PROMPT_NAME_MAX)
  const trimmedContent = content.trim().slice(0, PROMPT_CONTENT_MAX)
  // 内置项只认代码里的那一条，存档里同 id 的项直接丢弃
  if (!id || id === DEFAULT_PROMPT_ID || !trimmedName || !trimmedContent) {
    return null
  }
  return { id, name: trimmedName, content: trimmedContent }
}

/** 读取自定义列表；存档损坏、字段不合法、id 重复的项都不会进内存 */
const readPrompts = (): SystemPrompt[] => {
  try {
    const parsed: unknown = JSON.parse(read(KEYS.prompts) ?? '[]')
    if (!Array.isArray(parsed)) {
      return []
    }
    const seen = new Set<string>()
    return parsed.flatMap((item) => {
      const prompt = normalizePrompt(item)
      if (!prompt || seen.has(prompt.id)) {
        return []
      }
      seen.add(prompt.id)
      return [prompt]
    })
  } catch {
    return []
  }
}

/** 选中的 id 必须仍在库里，否则视为没选（回退默认），避免存档里的悬空 id 生效 */
const isValidSelection = (prompts: SystemPrompt[], id: string | null): id is string =>
  Boolean(id) && prompts.some((prompt) => prompt.id === id)

type PromptState = {
  /** 用户自定义项（按创建顺序），不含内置默认项 */
  prompts: SystemPrompt[]
  /** 当前生效的提示词 id；null 表示内置默认项 */
  selectedId: string | null
}

const readSelected = (prompts: SystemPrompt[]): string | null => {
  const id = read(KEYS.selected)
  return isValidSelection(prompts, id) ? id : null
}

const initialPrompts = readPrompts()

/** 提示词库的运行时状态；界面订阅它，请求方每次发请求时读 `getActivePromptContent()` */
export const useSystemPrompts = create<PromptState>(() => ({
  prompts: initialPrompts,
  selectedId: readSelected(initialPrompts),
}))

/** 内置默认项；name 为空串，由界面翻译成「默认 / Default」 */
export const defaultSystemPrompt = (): SystemPrompt => ({
  id: DEFAULT_PROMPT_ID,
  name: '',
  content: DEFAULT_PROMPT_CONTENT,
})

/** 列表展示顺序：内置默认项在最前，自定义项按创建顺序跟随 */
export const listSystemPrompts = (prompts = useSystemPrompts.getState().prompts): SystemPrompt[] => [
  defaultSystemPrompt(),
  ...prompts,
]

/**
 * 当前生效的提示词。选中项被删除、存档损坏或本来就没选时回退内置默认项，因此不会返回空内容。
 *
 * @returns 生效项（内置默认项或自定义项）
 */
export const getActiveSystemPrompt = (): SystemPrompt => {
  const { prompts, selectedId } = useSystemPrompts.getState()
  return prompts.find((prompt) => prompt.id === selectedId) ?? defaultSystemPrompt()
}

/** 请求体 `system` 字段的内容；在发请求时取值，切换提示词只影响之后的请求 */
export const getActivePromptContent = (): string => getActiveSystemPrompt().content

const commit = (prompts: SystemPrompt[]) => {
  write(KEYS.prompts, prompts.length ? JSON.stringify(prompts) : null)
  useSystemPrompts.setState({ prompts })
}

/**
 * 切换生效的提示词。id 为空、等于内置项 id 或不在库里时都退回内置默认项。
 *
 * @param id 目标提示词 id；null / DEFAULT_PROMPT_ID 表示回到内置默认项
 * @returns 无
 */
export const selectSystemPrompt = (id: string | null) => {
  const { prompts } = useSystemPrompts.getState()
  const selectedId = id === DEFAULT_PROMPT_ID || !isValidSelection(prompts, id) ? null : id
  write(KEYS.selected, selectedId)
  useSystemPrompts.setState({ selectedId })
}

/**
 * 新增一条自定义提示词（不自动切换生效项）。
 *
 * @param name 名称，首尾空白会被去掉
 * @param content 内容，首尾空白会被去掉
 * @returns 新项 id；名称为空或内容为空时返回 null，不写入
 */
export const createSystemPrompt = (name: string, content: string): string | null => {
  const trimmedName = name.trim().slice(0, PROMPT_NAME_MAX)
  const trimmedContent = content.trim().slice(0, PROMPT_CONTENT_MAX)
  if (!trimmedName || !trimmedContent) {
    return null
  }
  const prompt: SystemPrompt = { id: createId(), name: trimmedName, content: trimmedContent }
  commit([...useSystemPrompts.getState().prompts, prompt])
  return prompt.id
}

/**
 * 改写已有自定义项的名称和内容（重命名与编辑内容共用）。
 *
 * @param id 目标 id；内置项与不存在的 id 直接忽略
 * @param name 新名称
 * @param content 新内容
 * @returns 是否写入成功（名称为空或内容为空时返回 false）
 */
export const updateSystemPrompt = (id: string, name: string, content: string): boolean => {
  const trimmedName = name.trim().slice(0, PROMPT_NAME_MAX)
  const trimmedContent = content.trim().slice(0, PROMPT_CONTENT_MAX)
  const { prompts } = useSystemPrompts.getState()
  if (!trimmedName || !trimmedContent || !prompts.some((prompt) => prompt.id === id)) {
    return false
  }
  commit(
    prompts.map((prompt) =>
      prompt.id === id ? { ...prompt, name: trimmedName, content: trimmedContent } : prompt
    )
  )
  return true
}

/**
 * 删除一条自定义项。内置默认项不可删除，列表因此不会变空。
 * 删掉的正好是生效项时，选择回退到内置默认项，界面与请求都不会出现悬空引用。
 *
 * @param id 目标 id
 * @returns 是否删除成功
 */
export const removeSystemPrompt = (id: string): boolean => {
  const { prompts, selectedId } = useSystemPrompts.getState()
  if (!prompts.some((prompt) => prompt.id === id)) {
    return false
  }
  commit(prompts.filter((prompt) => prompt.id !== id))
  if (selectedId === id) {
    selectSystemPrompt(null)
  }
  return true
}
