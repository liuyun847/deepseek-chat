import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { setupLan } from './services/sync/lan/engine.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
// 手机直连：页面可见时开广播、不可见时停（浏览器里没有原生桥，setupLan 自己会退化成 unsupported）
setupLan()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
