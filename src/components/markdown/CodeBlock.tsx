import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useMemo, useReducer, useState } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import { IconCheckOutline16, IconCopyOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { isMermaidSupported } from '../../services/markdown/mermaid.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import styles from './CodeBlock.module.css'

/** 代码块标题栏：左侧语言名，右侧复制 */
const CodeInfoRow = ({
  code,
  infostring,
  showDiagram,
  onToggleDiagram,
  unsupported,
}: {
  code: string
  infostring: string
  showDiagram: boolean
  onToggleDiagram?: () => void
  /** 当前环境不支持给这门语言绘图：不显示切换按钮，只标注原因 */
  unsupported?: boolean
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.container}>
      {onToggleDiagram ? (
        <div className="md-code-block-switch" aria-label={t('mermaidSwitchLabel')}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={showDiagram}
            onClick={() => !showDiagram && onToggleDiagram()}
          >
            {t('mermaidDiagram')}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={!showDiagram}
            onClick={() => showDiagram && onToggleDiagram()}
          >
            {t('mermaidCode')}
          </button>
        </div>
      ) : (
        <span className={styles.info}>
          <span className={styles.name}>{infostring}</span>
          {unsupported ? <span className={styles.note}>{t('mermaidUnsupported')}</span> : null}
        </span>
      )}
      <button
        type="button"
        className={styles.button}
        onClick={async () => {
          if (!(await copyText(code))) {
            showToast({ key: 'copyFailed' })
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        <span>{t(copied ? 'copied' : 'copy')}</span>
      </button>
    </div>
  )
}

/** 代码块：语言包按需加载，不支持或尚未加载的语言按纯文本显示 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
}: {
  code: string
  infostring: string
  loading?: boolean
}) {
  const isMermaid = infostring.toLowerCase() === 'mermaid'
  // 旧 WebView 解析不了 mermaid 的 chunk（原因见 services/markdown/mermaid.ts）：探测不过就
  // 当普通代码块显示，既不去请求那个 chunk，也不挂 MermaidDiagram，自然不会有未捕获的 SyntaxError。
  const canDrawMermaid = isMermaid && isMermaidSupported()
  const [showDiagram, setShowDiagram] = useState(true)
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])
  const renderedHtml = useMemo(() => {
    const name = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(code, Prism.languages[name], name)
  }, [code, lang, loaded])
  return (
    <div className="md-code-block">
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          infostring={infostring}
          showDiagram={showDiagram}
          onToggleDiagram={canDrawMermaid ? () => setShowDiagram((show) => !show) : undefined}
          unsupported={isMermaid && !canDrawMermaid}
        />
      </div>
      {canDrawMermaid && showDiagram ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : (
        <pre dangerouslySetInnerHTML={{ __html: renderedHtml }}></pre>
      )}
    </div>
  )
})
