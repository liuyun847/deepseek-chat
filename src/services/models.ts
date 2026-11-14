import { create } from 'zustand'
import { listModels } from './api/client.js'
import type { ModelInfo } from './api/types.js'
import { DEFAULT_MODEL } from './settings.js'

/**
 * 内置兜底模型：没有 API Key 或 GET /models 拉取失败时使用。
 * 只保证默认模型可选，其余以服务端返回的列表为准。
 */
export const BUILTIN_MODELS: ModelInfo[] = [{ id: DEFAULT_MODEL }, { id: 'deepseek-v4-pro' }]

export type ModelListStatus =
  /** 没有 API Key，展示内置列表 */
  | 'builtin'
  /** 正在拉取 */
  | 'loading'
  /** 已拿到服务端列表 */
  | 'ready'
  /** 拉取失败，回退到内置列表 */
  | 'failed'

type ModelListState = {
  status: ModelListStatus
  models: ModelInfo[]
  /** 失败原因原文；由设置面板翻译后展示，语言切换后模板仍会跟着变 */
  error: string | null
}

/** 模型列表只在设置面板展示，放模块级 store 便于切换页签/重开弹窗时复用 */
export const useModelList = create<ModelListState>(() => ({
  status: 'builtin',
  models: BUILTIN_MODELS,
  error: null,
}))

/** 去掉 id 为空的项并按 id 去重，保留服务端给出的顺序与展示名 */
const normalize = (models: ModelInfo[]): ModelInfo[] => {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false
    }
    seen.add(model.id)
    return true
  })
}

/** 已成功拉取的 Key；同一个 Key 再打开设置不重复请求 */
let loadedFor: string | null = null
/** 请求序号：Key 变化或手动重试后，旧响应回来时直接丢弃 */
let sequence = 0

/**
 * 拉取可用模型列表。
 *
 * @param apiKey 当前 API Key；为空时保持内置列表，不发请求
 * @param force 手动重试时忽略缓存
 * @returns 无；状态写入 useModelList，失败时回退内置列表并记录原因
 */
export const loadModels = async (apiKey: string | null, force = false): Promise<void> => {
  if (!apiKey) {
    sequence += 1
    loadedFor = null
    useModelList.setState({ status: 'builtin', models: BUILTIN_MODELS, error: null })
    return
  }
  if (!force && loadedFor === apiKey && useModelList.getState().status === 'ready') {
    return
  }
  const id = ++sequence
  useModelList.setState({ status: 'loading' })
  try {
    const models = normalize(await listModels(apiKey))
    if (id !== sequence) {
      return
    }
    if (models.length === 0) {
      loadedFor = null
      useModelList.setState({ status: 'failed', models: BUILTIN_MODELS, error: '' })
      return
    }
    loadedFor = apiKey
    useModelList.setState({ status: 'ready', models, error: null })
  } catch (error) {
    if (id !== sequence) {
      return
    }
    loadedFor = null
    useModelList.setState({
      status: 'failed',
      models: BUILTIN_MODELS,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
