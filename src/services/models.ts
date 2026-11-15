import { useEffect } from 'react'
import { create } from 'zustand'
import { listModels } from './api/client.js'
import type { ModelInfo } from './api/types.js'
import { DEFAULT_MODEL, useSettings } from './settings.js'

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

/** 模型列表在设置面板与对话页控制条各展示一次，放模块级 store 让两处共用同一份结果 */
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

/** 模型下拉的一项：值与展示名，设置面板与对话页共用 */
export type ModelChoice = { value: string; label: string }

/**
 * 模型下拉的数据：当前值、选项、拉取状态与失败原因。
 * 设置面板（通用设置）与对话页输入区控制条共用，两处永远显示同一份列表和同一个当前值，
 * 改动只经 `setModel` 写回 `useSettings`，因此不存在两份状态需要互相同步。
 *
 * @returns model 当前模型 id；options 选项（含已选模型的兜底项）；status 列表来源；error 失败原因
 */
export const useModelChoices = (): {
  model: string
  options: ModelChoice[]
  status: ModelListStatus
  error: string | null
} => {
  const apiKey = useSettings((state) => state.apiKey)
  const model = useSettings((state) => state.model)
  const status = useModelList((state) => state.status)
  const models = useModelList((state) => state.models)
  const error = useModelList((state) => state.error)

  // 首次渲染（对话页或设置面板）时拉一次；同一个 Key 由 loadModels 内部缓存，不会重复请求
  useEffect(() => {
    void loadModels(apiKey)
  }, [apiKey])

  const options = models.map((item) => ({ value: item.id, label: item.name || item.id }))
  // 已选模型不在列表里（回退列表、服务端下线）时仍照原样显示，不能悄悄换成别的模型
  if (!options.some((option) => option.value === model)) {
    options.unshift({ value: model, label: model })
  }
  return { model, options, status, error }
}
