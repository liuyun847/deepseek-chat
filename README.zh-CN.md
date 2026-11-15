# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考（可选低 / 高 / 最高推理强度）、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 模型选择（列表来自 `GET /models`）、可命名的系统提示词库（设置 → 系统提示词）、简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key、设置和系统提示词库保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 多端同步（M1）

仓库自带一个零依赖的同步服务与客户端入口，用于在本机或局域网内多台设备之间同步会话与消息。

启动服务（Node.js 22+，只需要内置模块）：

```sh
node sync-server/server.mjs --port 7788
```

默认只监听 `127.0.0.1`，数据写在 `sync-server/data/sync-data.json`；局域网内其它设备要连时用 `--host 0.0.0.0`，并把本机 IP 填进客户端。客户端在 设置 → 多端同步 里填服务地址（例如 `http://127.0.0.1:7788`）、设备名，然后「测试连接」→「立即同步」。

同步按记录（会话、消息）粒度做 LWW：两边独有的记录都会保留，同一条记录两端都改过时保留最后修改的那一版；删除用墓碑同步，不会被另一端拉回来；分支树字段（`parentId` / `selectedChildId` / `rootMessageId`）原样同步。附件只同步文件信息，不含原件。接口与冲突规则见 [sync-server/README.md](sync-server/README.md)。

## 安卓 APK

同一份 `dist/` 也可以打成可安装的 APK：前端资源放进 APK 的 assets，由 WebView 以虚拟源 `https://dsapp.local` 供给（真正的安全源，localStorage 与 IndexedDB 都可用）。零 Gradle、零 Maven，链路是 aapt2 → javac → d8 → jar → zipalign → apksigner，由 `tools/build-apk.ps1` 驱动（Windows，PowerShell 7）。

```powershell
.\tools\setup-toolchain.ps1                     # 一次性：JDK 17 + build-tools 35.0.1 + android-35 装到 %USERPROFILE%\.devtools
pnpm --config.shell-emulator=true build       # 前端 -> dist/
.\tools\build-apk.ps1                          # -> dist-apk\deepseek-chat.apk
.\tools\verify-apk.ps1                         # 33 项产物校验
adb install -r dist-apk\deepseek-chat.apk
```

- API Key **可以在构建期写入产物**：把 key 放进 `.secrets/api-key.txt`（单行，已被 .gitignore 忽略），下一次 `pnpm build` 会把它注入主包 —— 这样 APK 与网页版装好/打开即可用，不必先配置。没有该文件时构建回退到原流程：在设置里填，存在应用源的 localStorage 里。设置里手填的 key 始终优先于内置值，`tools\verify-apk.ps1` 会把包里的 key 与密钥文件比对（日志只打指纹，不打 key 本身）。
- 包名沿用 `ds.app`，签名私钥是 `android\debug.keystore`（已 gitignore），因此新包能**覆盖升级**已装版本。丢了这份私钥就只能先卸载，本地聊天记录会一起丢。
- `versionName` 取自 `package.json`；`versionCode` 按 `major*10000 + minor*100 + patch` 折算（0.2.0 → 200）。发版前先改 `package.json`。
- `minSdk 26`、`targetSdk 34`（升到 35 会被 Android 15 强制 edge-to-edge），权限只有 `INTERNET` 一条。
- `android/` 是壳层：`MainActivity.java`（assets 供给、外链、选文件、SAF 导出、返回键）、`shell.js`（页面侧补丁：返回键、blob 导出、旧 WebView 的运行时 polyfill；由 `serveAsset` 插成入口 HTML `<head>` 最前面的同步脚本，先于 defer 主包执行）、`res/`、`AndroidManifest.xml`。
- 旧 WebView（实测 WebView 91）缺 Mermaid 依赖需要的新语法（产物里有 `class` 静态块），解析到那个 chunk 时会抛 SyntaxError。`src/services/markdown/mermaid.ts` 因此先做能力探测：不支持时图表按普通代码块显示并标注「当前环境不支持图表渲染」，连 mermaid 的 chunk 都不请求；支持时行为不变（照旧懒加载）。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，可在设置里切换模型；推理强度按 `output_config.effort` 传 `low` / `high` / `max`（默认 `high`），关闭深度思考时不传该字段。通过 Anthropic 兼容的 Messages / Files API 通信。请求的 `system` 字段取自设置 → 系统提示词里选中的那条（未选中时用内置默认项），切换只影响之后的请求，不改写已保存的消息。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
