import {
  applySyncedPromptSelection,
  applySyncedPrompts,
  loadPromptEntries,
  loadPromptSelection,
  loadPromptTombstones,
} from '../prompts.js'
import {
  applySyncedSettings,
  loadSettingsUpdatedAt,
  loadSyncedSettings,
} from '../settings.js'
import { extractLocalExtras, mergePromptLibrary } from './merge.js'
import type {
  PromptEntry,
  PromptSelectionEntry,
  SyncedSettings,
  SyncRecord,
} from './protocol.js'

/**
 * 非会话数据的落地/取数：设置、提示词库、当前选中的提示词。
 *
 * 为什么单独一层
 * ==============
 * 会话与消息存在 IndexedDB（chat-demo / chat-demo-sync），落地走 merge.ts 的
 * applyPulledRecords；而设置与提示词存在 localStorage，落地是「写键 + 让 zustand 立刻反映」。
 * HTTP 通道（engine.ts）用这一份胶水，合并规则仍然只有 merge.ts / protocol.ts 一套。
 *
 * 边界：这里只写白名单键 —— apiKey、syncDeviceId 没有任何写入口，远端记录带过来的值也盖不到它们。
 */

/** 本端要参与同步的非会话数据（可以直接展开进 buildLocalRecords 的入参） */
export type LocalSyncExtras = {
  /** 可同步的设置整份；null 表示这次读不出（同步时跳过设置记录，不会当成删除） */
  settings: SyncedSettings | null
  settingsUpdatedAt: number
  prompts: PromptEntry[]
  promptTombstones: Record<string, number>
  promptSelection: PromptSelectionEntry
}

/**
 * 读本端要同步的非会话数据。
 *
 * 设置从 zustand 的当前状态取（setter 都是「先写 localStorage 再更新状态」，两者一致）；
 * 提示词与选中项直接从 localStorage 取（列表可能有时间戳，读一遍才有）。
 *
 * @returns 设置、提示词、墓碑表、选中项
 */
export const readLocalSyncExtras = (): LocalSyncExtras => ({
  settings: loadSyncedSettings(),
  settingsUpdatedAt: loadSettingsUpdatedAt(),
  prompts: loadPromptEntries(),
  promptTombstones: loadPromptTombstones(),
  promptSelection: loadPromptSelection(),
})

/**
 * 把远端赢的非会话记录落到本机 localStorage，并让界面立刻反映（不等刷新）。
 *
 * 顺序有讲究：提示词库先落地，选中项最后落地 —— 选中项的有效性要对着「合并后的库」判断，
 * 否则刚同步过来的提示词会被误判成「本地不存在」而回落默认。
 *
 * @param pulled 远端赢的记录（会话/消息会被忽略，它们由 applyPulledRecords 处理）
 * @returns 实际发生变化的组数（设置 / 提示词 / 选中项各算一组），只用于展示
 * @sideeffect 写 localStorage、更新 useSettings 与 useSystemPrompts
 */
export const applyPulledLocalRecords = (pulled: SyncRecord[]): number => {
  const extras = extractLocalExtras(pulled)
  let changed = 0
  if (extras.settings) {
    if (applySyncedSettings(extras.settings.data, extras.settings.updatedAt)) {
      changed += 1
    }
  }
  if (extras.prompts.length > 0) {
    const merged = mergePromptLibrary(loadPromptEntries(), loadPromptTombstones(), extras.prompts)
    if (applySyncedPrompts(merged.prompts, merged.tombstones)) {
      changed += 1
    }
  }
  if (extras.selection) {
    if (applySyncedPromptSelection(extras.selection.selectedId, extras.selection.updatedAt)) {
      changed += 1
    }
  }
  return changed
}
