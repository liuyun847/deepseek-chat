type Mermaid = typeof import('mermaid').default

let mermaidPromise: Promise<Mermaid> | null = null
let renderQueue = Promise.resolve()
let nextId = 0

const loadMermaid = () => {
  mermaidPromise ??= import('mermaid')
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidPromise = null
      throw error
    })
  return mermaidPromise
}

/**
 * class 静态块探测（ES2022 / Chrome 94）：Mermaid 的产物里就在用，缺了整块 chunk 解析不了。
 *
 * new Function 只编译不执行 —— 构造时就把语句编译掉，语法不认识会抛 SyntaxError。
 *
 * @returns true = 认识；false = 不认识；null = 探测不了（CSP 禁了 eval）
 */
const detectClassStaticBlock = (): boolean | null => {
  try {
    void new Function('class A{static{}}')
    return true
  } catch (error) {
    // CSP 不给 unsafe-eval 时抛的是 EvalError，那是「没权限试」而不是「语法不支持」，
    // 所以返回 null 让下面的 API 判据接手，而不是直接判负把图表关掉。
    return error instanceof Error && error.name === 'EvalError' ? null : false
  }
}

/**
 * 运行时能力的判据。
 *
 * 为什么要判：Mermaid 及其依赖在 node_modules 里，构建只对本项目源码跑 swc（rspack 规则排除了
 * node_modules），所以它的 chunk 原样产出 —— 里面有 class 静态块这类新语法。旧 WebView
 * （本机雷电 9 的 WebView 91.0.4472.114）解析到这个 chunk 时会抛 SyntaxError：动态 import 的
 * Promise 直接 reject，页面既拿不到图，也没人接得住那个错。不支持就别去请求它。
 *
 * @returns true 表示可以按原路径懒加载 mermaid 并绘图
 */
const detectMermaidSupport = (): boolean => {
  // 语法层面确定不支持就不用再看别的：chunk 根本解析不了
  if (detectClassStaticBlock() === false) {
    return false
  }
  // structuredClone：Chrome 98 / Firefox 94 / Safari 15.4 起步，Mermaid 的依赖会调用它；
  // 同时也是「比 91 新」的一个简单界标，CSP 环境下照样能判。
  return typeof structuredClone === 'function'
}

/** 缓存探测结果：同一页面生命周期内能力不会变，没必要每次渲染都重新编译探测语句 */
let supported: boolean | null = null

/**
 * 当前运行时能否绘制 Mermaid 图表。
 *
 * 调用方（CodeBlock）不满足条件时按普通代码块显示，不会触发 mermaid 的懒加载。
 *
 * @returns true 表示支持，false 表示应降级为代码块
 */
export const isMermaidSupported = (): boolean => (supported ??= detectMermaidSupport())

/** 转义图片标签，对同一图中的全部标签生效。 */
const sanitizeMermaid = (code: string) => code.replace(/<((?:img|image)\s+)/gi, '&lt;$1')

/** 串行执行初始化和绘制，避免不同图表互相覆盖 Mermaid 的全局配置。 */
export const renderMermaid = (
  code: string,
  dark: boolean,
  isCancelled: () => boolean
): Promise<string | null> => {
  const result = renderQueue.then(async () => {
    if (isCancelled() || !code.trim()) {
      return null
    }

    const mermaid = await loadMermaid()
    if (isCancelled()) {
      return null
    }

    mermaid.initialize({
      theme: dark ? 'dark' : 'default',
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
    })

    const { svg } = await mermaid.render(`standalone-mermaid-${nextId++}`, sanitizeMermaid(code))
    return isCancelled() ? null : svg
  })

  // 某张图失败不阻塞后续图表；调用方仍收到原始任务的错误。
  renderQueue = result.then(
    () => {},
    () => {}
  )
  return result
}
