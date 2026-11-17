import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

/** 本机密钥文件：单行 API key，已被 .gitignore 忽略，不随仓库分发 */
const SECRET_FILE = '.secrets/api-key.txt'

/**
 * 读取内置 API Key。
 *
 * 为什么不写进 src/ 或环境变量：key 绝不能进 git，源码里也不该出现；
 * 放在 .secrets/api-key.txt 里由构建期读入、注入成常量，网页 dist 与 APK（同一份 dist）
 * 就都自带可用 key —— 装好/打开即可发消息，不必先去设置里填。
 *
 * @returns 合法的 key；文件缺失、为空或格式不对时返回空串
 */
const readBuiltinApiKey = (): string => {
  try {
    const key = readFileSync(path.join(root, SECRET_FILE), 'utf8').trim()
    return /^sk-[A-Za-z0-9]{16,}$/.test(key) ? key : ''
  } catch {
    return ''
  }
}

/**
 * 密钥指纹：前 4 位 + 长度 + sha256 前 8 位，可安全写进构建日志。
 *
 * @param key 明文 key
 * @returns 供日志展示的描述串（不含完整 key）
 */
const keyFingerprint = (key: string): string =>
  `${key.slice(0, 4)}…，长度 ${key.length}，sha256 ${createHash('sha256').update(key).digest('hex').slice(0, 8)}`

/**
 * 是否把密钥注入产物。
 *
 * 默认注入：APK 与「直接打开 dist/index.html」都靠产物自带 key 开箱可用，
 * tools\build-apk.ps1 的第 0 步也在核对它。
 * 由本机 Web 服务（local-server/）托管时用 `pnpm build:web`（DS_INLINE_KEY=0）：
 * 那种场景 key 只留在服务端，网页产物里出现明文 key 就是泄露 —— 浏览器拿到 JS 就拿到了它。
 */
const inlineApiKey = process.env.DS_INLINE_KEY !== '0'

const builtinApiKey = inlineApiKey ? readBuiltinApiKey() : ''
// 用 process.stdout 而不是 console：本文件在 oxlint 的 no-console 规则覆盖范围内
process.stdout.write(
  builtinApiKey
    ? `[build] 已注入内置 API key（${keyFingerprint(builtinApiKey)}）\n`
    : inlineApiKey
      ? `[build] 未找到 ${SECRET_FILE}，产物不含内置 key：在设置里手动填\n`
      : '[build] DS_INLINE_KEY=0：产物不含内置 key（给本机 Web 服务托管用）\n'
)

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    // 内置 API key 走构建期常量：运行时无需额外请求/文件，file:// 与 WebView 都成立
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __DS_BUILTIN_API_KEY__: JSON.stringify(builtinApiKey),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
    }),
  ],
  performance: { hints: false },
  devServer: { port: 8090, ...devServer },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
