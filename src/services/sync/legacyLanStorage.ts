/**
 * 一次性清理旧版「手机直连」（P2P 通道）留在 localStorage 里的 4 个键。
 *
 * 为什么还要清理
 * ============
 * 那条链路已整条移除（盘点与实施记录见 .dsh/.project/deepseek-chat-本地服务/ 下的
 * REMOVE-P2P-PLAN.md 与 REMOVE-P2P-IMPL.md），但升级上来的旧 APK/浏览器里仍留着这 4 个键：
 * lan-key 是一份 PBKDF2 派生密钥、lan-pair-tag 是口令指纹。它们既不在同步白名单里
 * （见 protocol.ts 的 SyncedSettings），也不会再被任何代码读到，留着只是一份无主的秘密。
 *
 * 启动时删掉即可：removeItem 幂等，重复执行没有副作用。
 */

/** 旧「手机直连」用过的存储键（原实现在已删除的 P2P 前端模块里） */
const LEGACY_LAN_KEYS = [
  'chat-demo:lan-enabled',
  'chat-demo:lan-key',
  'chat-demo:lan-pair-tag',
  'chat-demo:lan-peers',
]

/**
 * 清掉旧「手机直连」的存储键。
 *
 * 无返回值、不抛错：隐私模式或禁用存储时 removeItem 会抛，这里吞掉 —— 清理是尽力而为，
 * 下次启动会再试。
 */
export const clearLegacyLanStorage = (): void => {
  for (const key of LEGACY_LAN_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      // 存储不可用：忽略，下次启动再试
    }
  }
}
