import { useSyncExternalStore } from 'react'
import { useSettings, type FontScale, type ThemePreference } from '../services/settings.js'

export type Theme = 'light' | 'dark'

const query = window.matchMedia('(prefers-color-scheme: dark)')

const subscribeOsTheme = (listener: () => void) => {
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getOsTheme = (): Theme => (query.matches ? 'dark' : 'light')

const resolveTheme = (preference: ThemePreference, osTheme: Theme): Theme =>
  preference === 'system' ? osTheme : preference

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取系统设置 */
export const useTheme = (): Theme => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  return resolveTheme(preference, osTheme)
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
}

/** 同步页面主题、根画布背景和支持 theme-color 的浏览器栏。 */
const applyTheme = (theme: Theme) => {
  const body = document.body
  // 主题切换帧禁用过渡，使页面颜色同步更新
  body.classList.add('change-theme')
  body.classList.toggle('dark', theme === 'dark')
  body.classList.toggle('light', theme === 'light')
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
  document.documentElement.style.colorScheme = theme
  // 首次背景色同步在样式表加载完成后执行，适配 WebKit 的 defer 脚本执行顺序。
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  setTimeout(() => {
    body.classList.remove('change-theme')
  }, 0)
}

let appliedTheme: Theme | null = null

const syncTheme = () => {
  const theme = resolveTheme(useSettings.getState().themePreference, getOsTheme())
  if (theme !== appliedTheme) {
    appliedTheme = theme
    applyTheme(theme)
  }
}

/**
 * 应用字号档位：只写 body 的一个属性，具体像素值全由 theme.css 里的
 * `body[data-font-scale]` 覆盖 --ds-fs-* / --ds-lh-* 完成（CSS 里没有 normal 分支，
 * 因为 normal 就是基础值，所以这里直接移除属性）。
 *
 * @param fontScale 字号档位
 * @sideeffect 增删 document.body 的 data-font-scale
 */
export const applyFontScale = (fontScale: FontScale) => {
  const body = document.body
  if (fontScale === 'normal') {
    body.removeAttribute('data-font-scale')
  } else {
    body.setAttribute('data-font-scale', fontScale)
  }
}

let appliedFontScale: FontScale | null = null

const syncFontScale = () => {
  const { fontScale } = useSettings.getState()
  if (fontScale !== appliedFontScale) {
    appliedFontScale = fontScale
    applyFontScale(fontScale)
  }
}

/**
 * 首屏渲染前同步应用一次字号，之后随设置变化即时更新
 * （刷新后由首屏这次调用恢复；多端同步落地走 reloadSettingsFromStorage → 订阅同样会触发）。
 */
export const setupFontScale = () => {
  syncFontScale()
  useSettings.subscribe(syncFontScale)
}

/** 首屏渲染前同步应用一次，之后随主题设置与系统深浅色变化更新（字号见 setupFontScale） */
export const setupTheme = () => {
  syncTheme()
  if (document.readyState !== 'complete') {
    window.addEventListener('load', syncPageBackground, { once: true })
  }
  query.addEventListener('change', syncTheme)
  useSettings.subscribe(syncTheme)
  // 字号与深浅色是两件独立的事，但都只在首屏设置一次，因此共用这一个入口（见 main.tsx）
  setupFontScale()
}
