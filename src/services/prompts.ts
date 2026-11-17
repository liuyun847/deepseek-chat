import { create } from 'zustand'
import { createId } from '../utils/id.js'
import {
  canonicalJson,
  PROMPT_CONTENT_MAX,
  PROMPT_NAME_MAX,
  type PromptEntry,
  type PromptSelectionEntry,
} from './sync/protocol.js'

/** 名称与内容长度上限：提示词是逐字发送的文本，过长会白占 token 并撑大 localStorage */
export { PROMPT_CONTENT_MAX, PROMPT_NAME_MAX }

/** 内置默认提示词的 id：不可编辑、不可删除，展示名由界面按语言翻译 */
export const DEFAULT_PROMPT_ID = 'default'

/**
 * 内置默认提示词的内容，也就是接入提示词库之前写死的文案（`store.ts` 的 `SYSTEM_PROMPT`）。
 * 没有选中任何自定义项、或选中项已被删除时发送这条。
 */
export const DEFAULT_PROMPT_CONTENT = '该助手为DeepSeek，由深度求索公司创造。'

/**
 * 用户自定义的系统提示词；内置默认项不落存储，始终由代码提供。
 *
 * createdAt / updatedAt 是多端同步用的：
 *  - updatedAt 是这条提示词的「本地最后修改时间」，逐条 LWW 的时间戳
 *  - createdAt 只影响列表里的先后顺序（不参与冲突判定）
 * 老存档里没有这两个字段时按 0 处理：LWW 依然确定（撞车时比设备 id），
 * 只是这类「史前数据」会被对端任何一次更新的改动压掉，符合预期。
 */
export type SystemPrompt = PromptEntry

/** 存储键沿用 `settings.ts` 的 `chat-demo:` 前缀；提示词库是纯文本小数据，没必要进 IndexedDB */
const KEYS = {
  /** 自定义提示词列表（JSON 数组），空列表时删除该键 */
  prompts: 'chat-demo:system-prompts',
  /** 当前生效的提示词 id；用内置默认项时删除该键 */
  selected: 'chat-demo:system-prompt-selected',
  /** 选中项的最后修改时间（毫秒）：同步选中项时的时间戳 */
  selectedAt: 'chat-demo:system-prompt-selected-updated-at',
  /** 已删除提示词的墓碑：{ id: 删除时刻 }，让删除也能同步出去（否则会被对端当成新条目拉回来） */
  tombstones: 'chat-demo:system-prompt-tombstones',
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

/** 非负整数时间戳；缺字段、坏值一律 0 */
const stampOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/** 逐条校验存档：只保留三个字段都是非空字符串的项，并截断到长度上限 */
const normalizePrompt = (value: unknown): SystemPrompt | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { id, name, content, createdAt, updatedAt } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string' || typeof content !== 'string') {
    return null
  }
  const trimmedName = name.trim().slice(0, PROMPT_NAME_MAX)
  const trimmedContent = content.trim().slice(0, PROMPT_CONTENT_MAX)
  // 内置项只认代码里的那一条，存档里同 id 的项直接丢弃
  if (!id || id === DEFAULT_PROMPT_ID || !trimmedName || !trimmedContent) {
    return null
  }
  const created = stampOf(createdAt)
  return {
    id,
    name: trimmedName,
    content: trimmedContent,
    createdAt: created,
    // 只有 createdAt 的老数据：拿创建时间当修改时间，至少不会比创建还早
    updatedAt: stampOf(updatedAt) || created,
  }
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

/** 读取墓碑表；坏数据一律当作空 */
const readTombstones = (): Record<string, number> => {
  try {
    const parsed: unknown = JSON.parse(read(KEYS.tombstones) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const result: Record<string, number> = {}
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      const stamp = stampOf(at)
      if (id && stamp > 0) {
        result[id] = stamp
      }
    }
    return result
  } catch {
    return {}
  }
}

/** 存储里的选中 id（原样，不校验是否还在库里） */
const normalizeSelectedId = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? ''
  return !trimmed || trimmed === DEFAULT_PROMPT_ID ? null : trimmed
}

const readSelectedRaw = (): string | null => normalizeSelectedId(read(KEYS.selected))

/** 选中项的最后修改时间（毫秒）；0 表示从没选过 */
export const loadPromptSelectionUpdatedAt = (): number => stampOf(Number(read(KEYS.selectedAt)))

/** 选中的 id 必须仍在库里，否则视为没选（回退默认），避免存档里的悬空 id 生效 */
const isValidSelection = (prompts: SystemPrompt[], id: string | null): id is string =>
  Boolean(id) && prompts.some((prompt) => prompt.id === id)

type PromptState = {
  /** 用户自定义项（按创建顺序），不含内置默认项 */
  prompts: SystemPrompt[]
  /** **生效**的提示词 id；null 表示内置默认项。悬空 id 在这里已经回落成 null */
  selectedId: string | null
}

const readSelected = (prompts: SystemPrompt[]): string | null => {
  const id = readSelectedRaw()
  return isValidSelection(prompts, id) ? id : null
}

const initialPrompts = readPrompts()

/** 提示词库的运行时状态；界面订阅它，请求方每次发请求时读 `getActivePromptContent()` */
export const useSystemPrompts = create<PromptState>(() => ({
  prompts: initialPrompts,
  selectedId: readSelected(initialPrompts),
}))

/**
 * 按 localStorage 现状重载提示词库与生效的选中项。
 *
 * 只重读、不做「清理悬空选中」这类写操作（那是落地路径 applySyncedPrompts 的事）；
 * 与 settings.ts 的 reloadSettingsFromStorage 对称。
 *
 * @sideeffect 覆盖 useSystemPrompts 的 prompts 与 selectedId
 */
export const reloadPromptsFromStorage = (): void => {
  const prompts = readPrompts()
  useSystemPrompts.setState({ prompts, selectedId: readSelected(prompts) })
}

/** 内置默认项；name 为空串，由界面翻译成「默认 / Default」 */
export const defaultSystemPrompt = (): SystemPrompt => ({
  id: DEFAULT_PROMPT_ID,
  name: '',
  content: DEFAULT_PROMPT_CONTENT,
  createdAt: 0,
  updatedAt: 0,
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

/** 记一条墓碑（删除要能传到别的设备，光从列表里删掉对端会把它当新条目拉回来） */
const markDeleted = (id: string): void => {
  const tombstones = readTombstones()
  // 单调递增：同一毫秒内删两次也不会让墓碑「变旧」而被活记录压回去
  tombstones[id] = Math.max(Date.now(), (tombstones[id] ?? 0) + 1)
  write(KEYS.tombstones, JSON.stringify(tombstones))
}

/**
 * 切换生效的提示词。id 为空、等于内置项 id 或不在库里时都退回内置默认项。
 *
 * 每次切换都会刷新「选中项最后修改时间」；内容没变时同步层会沿用记账里的版本，
 * 因此多点几次不会白推一条记录。
 *
 * @param id 目标提示词 id；null / DEFAULT_PROMPT_ID 表示回到内置默认项
 * @returns 无
 */
export const selectSystemPrompt = (id: string | null) => {
  const { prompts } = useSystemPrompts.getState()
  const selectedId = id === DEFAULT_PROMPT_ID || !isValidSelection(prompts, id) ? null : id
  write(KEYS.selected, selectedId)
  write(KEYS.selectedAt, String(Math.max(Date.now(), loadPromptSelectionUpdatedAt() + 1)))
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
  const now = Date.now()
  const prompt: SystemPrompt = {
    id: createId(),
    name: trimmedName,
    content: trimmedContent,
    createdAt: now,
    updatedAt: now,
  }
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
      prompt.id === id
        ? {
            ...prompt,
            name: trimmedName,
            content: trimmedContent,
            // 单调递增：时钟回拨也不会让这次改动「比上一版更旧」
            updatedAt: Math.max(Date.now(), prompt.updatedAt + 1),
          }
        : prompt
    )
  )
  return true
}

/**
 * 删除一条自定义项。内置默认项不可删除，列表因此不会变空。
 * 删掉的正好是生效项时，选择回退到内置默认项，界面与请求都不会出现悬空引用。
 *
 * 删除会记进墓碑表，下次同步把删除标记推出去（否则对端会把这条又拉回来）。
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
  markDeleted(id)
  if (selectedId === id) {
    selectSystemPrompt(null)
  }
  return true
}

// ── 多端同步接口 ────────────────────────────────────────────────────────────

/**
 * 本地提示词库（含时间戳），供同步层构造记录。
 * @returns 逐条提示词，顺序即界面顺序
 */
export const loadPromptEntries = (): SystemPrompt[] => readPrompts()

/**
 * 本地墓碑表（id → 删除时刻），供同步层构造墓碑记录。
 * @returns 已删除且尚未被清理的提示词
 */
export const loadPromptTombstones = (): Record<string, number> => readTombstones()

/**
 * 本地选中的提示词 + 最后修改时间，供同步层构造选中项记录。
 *
 * selectedId 取存储里的原样值（不校验是否还在库里）：这个原样值才是「用户的意图」，
 * 悬空时由 store 的 selectedId 回落成默认（见 readSelected），而不是把存储改写成 null ——
 * 否则「A 端库里没这条、B 端库里有」时两端会互相把对方的选择改成 null，来回推个不停。
 *
 * @returns 选中 id（null = 内置默认）与它的最后修改时间
 */
export const loadPromptSelection = (): PromptSelectionEntry => ({
  selectedId: readSelectedRaw(),
  updatedAt: loadPromptSelectionUpdatedAt(),
})

/**
 * 落地远端赢的提示词库（整份列表 + 墓碑表）。
 *
 * 只写 chat-demo:system-prompts 与墓碑表；选中项由 applySyncedPromptSelection 单独处理。
 * 例外：如果远端把「本机正选中的那条」删掉了，这里顺手把选中项回落成默认，
 * 并把回落记成一次本地修改（时间戳往前推），让「删了提示词 → 谁都不用选中它」传下去。
 *
 * @param entries 合并后的提示词库
 * @param tombstones 合并后的墓碑表
 * @returns 本地是否有实际变化（供同步结果计数）
 * @sideeffect 写 localStorage、更新 useSystemPrompts
 */
export const applySyncedPrompts = (
  entries: SystemPrompt[],
  tombstones: Record<string, number>
): boolean => {
  const before = canonicalJson({
    prompts: useSystemPrompts.getState().prompts,
    tombstones: readTombstones(),
  })
  const list = entries.flatMap((entry) => {
    const prompt = normalizePrompt(entry)
    return prompt ? [prompt] : []
  })
  write(KEYS.prompts, list.length ? JSON.stringify(list) : null)
  write(
    KEYS.tombstones,
    Object.keys(tombstones).length ? JSON.stringify(tombstones) : null
  )
  const raw = readSelectedRaw()
  if (raw !== null && !list.some((prompt) => prompt.id === raw)) {
    write(KEYS.selected, null)
    write(KEYS.selectedAt, String(Math.max(Date.now(), loadPromptSelectionUpdatedAt() + 1)))
  }
  reloadPromptsFromStorage()
  return canonicalJson({ prompts: list, tombstones }) !== before
}

/**
 * 落地远端赢的「当前选中项」。
 *
 * 远端给的 id 在本机库里不存在时（对方的提示词还没同步过来、或已被删掉），
 * 存储原样保留那个 id（意图），store 的 selectedId 自动回落成默认 —— 界面不会出现悬空选中，
 * 等那条提示词同步到位，选择会自己恢复。整个过程不抛异常。
 *
 * @param selectedId 远端选中项（null = 内置默认）
 * @param updatedAt 这条选中项记录的时间
 * @returns 本地是否有实际变化（供同步结果计数）
 * @sideeffect 写 localStorage、更新 useSystemPrompts
 */
export const applySyncedPromptSelection = (
  selectedId: string | null,
  updatedAt: number
): boolean => {
  const next = normalizeSelectedId(selectedId)
  const stamp = stampOf(updatedAt)
  const before = canonicalJson({ selectedId: readSelectedRaw(), updatedAt: loadPromptSelectionUpdatedAt() })
  write(KEYS.selected, next)
  write(KEYS.selectedAt, String(stamp))
  useSystemPrompts.setState({ selectedId: readSelected(useSystemPrompts.getState().prompts) })
  return canonicalJson({ selectedId: next, updatedAt: stamp }) !== before
}
