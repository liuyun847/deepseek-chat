import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { clearLegacyLanStorage } from './services/sync/legacyLanStorage.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
// 旧版「手机直连」已移除：清掉它留在 localStorage 里的派生密钥与口令指纹（升级设备的一次性清理）
clearLegacyLanStorage()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
