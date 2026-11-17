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
- 对话页输入区可直接选模型与推理强度（与设置 → 通用设置里的两项同一份值，改一处另一处跟着变）；模型列表来自 `GET /models`；可命名的系统提示词库（设置 → 系统提示词，支持按名称与内容搜索）；简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key、设置和系统提示词库保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 多端同步（M1）

仓库自带一个零依赖的同步服务与客户端入口，用于在本机或局域网内多台设备之间同步会话与消息。

启动服务（Node.js 22+，只需要内置模块）。Windows 上直接用下面两个脚本：幂等，且只有 `GET /api/health` 报出 `format=chat-demo-sync` 才返回 0：

```powershell
.\sync-server\start.ps1                      # 启动（隐藏窗口，端口 7788；用 -Port 或 SYNC_PORT 改）
.\sync-server\stop.ps1                       # 按端口停止，幂等
node sync-server/server.mjs --port 7788      # 或前台跑，看服务自己的输出
```

日志：`sync-server\logs\start.log`（启停结果）。服务本身只往 stdout 写，start.ps1 刻意不做重定向（原因写在 start.ps1 文件头：一旦重定向，长驻的 node 会占住开机自启的 stderr 文件，下次登录那次自启就变成静默空转）。

默认只监听 `127.0.0.1`，数据写在 `sync-server/data/sync-data.json`；局域网内其它设备要连时用 `--host 0.0.0.0`，并把本机 IP 填进客户端。客户端在 设置 → 多端同步 里填服务地址（例如 `http://127.0.0.1:7788`）、设备名，然后「测试连接」→「立即同步」。

由 `local-server` 托管的浏览器页面（见下一节）可以**留空**：同步自动走同源 `/sync/api/*`，由本机服务转发到 `127.0.0.1:7788`，于是手机同步来的会话零配置就能看到。填了地址则优先用填的那台。

数据文件被外部更新后**不需要重启 sync-server**：它在 `/api/health`、`/api/state`、`POST /api/sync` 处理前先 stat 一次，发现被别处写过就重读并按 LWW 并进内存——手机 P2P 推来的会话因此立刻能在浏览器看到。

开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-sync.vbs` 每次登录用无窗口的 Windows PowerShell 5.1 跑一次 `sync-server\start.ps1`（与下一节的 Web 服务同一套范式；改名成 `.vbs.disabled` 即关闭，它自己的 stderr 落在 `sync-server\logs\autostart.err.log`）。只监听 `127.0.0.1:7788`：手机走 P2P（`lan-peer`）到这台电脑，不经过这个端口。

同步按记录粒度做 LWW：两边独有的记录都会保留，同一条记录两端都改过时保留最后修改的那一版；删除用墓碑同步，不会被另一端拉回来；分支树字段（`parentId` / `selectedChildId` / `rootMessageId`）原样同步。附件只同步文件信息，不含原件。

同步的记录共五种：`session`、`message`、`settings`（除 API Key 外的设置整份一条，最新的整份覆盖旧的）、`prompt`（提示词逐条一条记录，删除走墓碑）、`prompt-selection`（当前选中的提示词，一条记录；远端选中的 id 在本机还不存在时先回落默认，等它同步过来自动生效）。**API Key、设备 id、设备名、手机直连的口令永远不同步**，只留在各设备本机，远端记录也盖不到它们。协议版本为 **2**：v1 客户端连 v2 服务端会拒绝同步，v2 客户端连 v1 服务端会收到 400（两边一起升级）。只有会话与消息的老数据文件可以直接用。接口与冲突规则见 [sync-server/README.md](sync-server/README.md)。

## 手机直连（局域网 P2P，无需服务器）

设置 → 手机直连：两台手机连同一个 Wi-Fi，在两边输入**同一个口令**（≥8 位）即可。之后它们互相发现、自动同步，不需要任何服务器，也不需要填 IP。

- 发现：APK 里的原生层（`LanLink.java`）用 UDP 广播（端口 47823）周期性地发「我在线：设备 id、设备名、TCP 端口、口令指纹」，同时监听别人的广播；Android 9 起收广播必须持有 `WifiManager.MulticastLock`（权限 `CHANGE_WIFI_MULTICAST_STATE`），锁在页面可见时持有、退到后台立即释放并停止广播。
- 传输：每台设备的 `ServerSocket` 绑随机端口，一问一答走 TCP，帧格式是「4 字节大端长度 + 正文」；正文是加密信封（明文只有设备 id、请求 id、时间戳、随机 iv）。
- 加密：口令经 PBKDF2-HMAC-SHA256（12 万轮，固定盐）派生 256 位密钥，消息 gzip 后用 AES-GCM 加密，信封里的 from/id/ts 作为 AAD 参与认证。口令本身不落盘，本机只存派生出的密钥；广播里的「口令指纹」是密钥的 SHA-256 前 6 字节，两端一致才算配对成功。口令不同的一端解不开包（GCM 校验失败）也不会同步。
- 合并：复用 HTTP 通道同一套 LWW 与墓碑规则（`src/services/sync/merge.ts`），只是把「服务端全量」换成「对方缺的那部分」。两端数据版本指纹（`stampOf`）相同时连记录都不发，只跑一次 hello。
- 调度：`deviceId` 字典序小的一方负责主动同步，另一方需要时发一个 ping 让对方来拉；本地数据改动后 4 秒防抖自动推送，另有 45 秒一次的版本巡检。附件只同步文件信息，不含原件（与 HTTP 通道一致）。

按代码分层，传输层不碰明文：

```text
LanLink.java            UDP 广播发现 + TCP 收发（只搬字节，不解析业务）
  ↕ addJavascriptInterface
shell.js  window.__dsLan   回调排队 + Promise 化（大块数据由页面回头同步取）
  ↕
lan/bridge.ts          原生桥的 TS 封装
lan/crypto.ts          PBKDF2 / AES-GCM / 口令指纹 / gzip、base64
lan/protocol.ts        信封与消息结构、时间窗口、版本指纹
lan/transfer.ts        点对点差异合并（复用 merge.ts 的判定）
lan/exchange.ts        接到 IndexedDB（读全量、落地、写记账）
lan/engine.ts          编排：发现表、自动同步、节流、自检
```

没有第二台手机时的验证办法：设置 → 手机直连 → 「本机自检」会向自己的 TCP 端口发一次 ping 和 hello，完整走一遍原生收包 → 页面解密 → 应答加密封回，结果显示 RTT 与数据版本是否一致。双进程协议模拟与「宿主机进程当第二台手机」的联调脚本见 [tools/lan-sim/README.md](tools/lan-sim/README.md)。

限制（明确说明）：只在同一网段内有效，访客网络/AP 隔离会挡掉广播；跨网段、需要中转的场景请继续用下面的 HTTP 同步。

### 电脑作为直连对端

`lan-peer/` 让电脑成为同一套协议的一等对端：手机可以直接和电脑同步，中间没有任何 HTTP 服务。线格式、消息类型、`PROTO` 版本、合并规则**一行没改**，手机 App 侧零改动。

```powershell
# 一次性：口令两端必须相同（≥8 位）。start.ps1 从 <仓库>\.secrets\lan-passphrase.txt 读（单行，已 gitignore），
# 也可以用 -Passphrase 参数或 $env:LAN_PASSPHRASE；它不会出现在 node 的命令行里。
notepad .secrets\lan-passphrase.txt

.\lan-peer\start.ps1        # 首次会先编译共享 TS 模块，然后隐藏启动并自检（TCP 端口可连 + 广播已发）
.\lan-peer\stop.ps1         # 停止，幂等
node lan-peer\peer.mjs --passphrase <同一个口令>   # 想前台看日志就直接这样跑
```

手机侧：设置 → 手机直连 → 填**同一个口令** → 保存并配对。「发现的设备」里约 4 秒内出现电脑，之后自动同步（手机端永远是发起方：`dev-…` 字典序小于电脑的 `pc-…`；电脑有新数据时发一个 ping 让手机来拉）。

- 数据只有一份 JSON：`sync-server/data/sync-data.json`，就是 `sync-server/server.mjs` 用的那个文件（`{format:'chat-demo-sync',version:2,records:{…}}`）。所以 P2P 同步过来的记录，网页端连上 7788 就能看到，反过来也一样；合并仍是 LWW + 墓碑，不会把删除复活。
- 写入是「读最新 → 合并 → 原子 rename」。如果 7788 同时在跑，它会用自己的内存视图整份覆盖文件，期间只有 P2P 才有的记录会短暂消失——本程序每 45 秒按 LWW 把它们补回（墓碑时间更新，仍然优先）。最干净的做法是两者只用其一。
- 多网卡：默认往每块非回环网卡的广播地址 + 255.255.255.255 都发一份。用 `--iface 192.168.1.10`（网卡地址，或该网段的广播地址）钉死一块网卡，例如本机有 VirtualBox 主机网卡时。
- 只在同一网段有效：访客 Wi-Fi / AP 隔离会挡掉广播，那种网络里手机发现不到电脑。
- 防火墙：放行入站 **UDP 47823**（发现）与**入站 TCP 上本程序挑的端口**（默认随机，启动日志与 `lan-peer/logs/state.json` 里有；想固定就加 `--port 47824`）。Windows 首次运行只会弹 TCP 监听那一条，UDP 要手工加：

```powershell
New-NetFirewallRule -DisplayName 'chat-demo LAN P2P' -Direction Inbound -Protocol UDP -LocalPort 47823 -Action Allow
New-NetFirewallRule -DisplayName 'chat-demo LAN P2P TCP' -Direction Inbound -Protocol TCP -LocalPort 47824 -Action Allow
```

日志：`lan-peer\logs\peer.log`（服务自身）、`start.log`（启停结果）、`state.json`（当前端口/记录数/在线对端，也是 `start.ps1` 自检的依据）。口令永远不进日志，只出现「已配置」与公开的口令指纹 `pairTag`。开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-lan-peer.vbs`，改名成 `.vbs.disabled` 即禁用（与 Web 服务同一套路）。

## 本机 Web 服务（浏览器访问 + 开机自启）

`local-server/` 是一个零依赖的 Node 服务（只用内置模块）：把 `dist/` 静态托管给浏览器；把 `/anthropic/*` 与 `/models` 反向代理到 `https://api.deepseek.com`；把 `/sync/api/*` 反向代理到同步服务（默认 `127.0.0.1:7788`，可用 `SYNC_UPSTREAM` 改）。**API key 只存在服务端**，浏览器产物里一个字都没有。

```powershell
pnpm --config.shell-emulator=true build:web   # 构建不含内置 key 的前端产物 -> dist/
.\local-server\start.ps1                      # 启动：/api/health 自检通过才返回 0
.\local-server\stop.ps1                       # 停止：按端口找 PID，幂等
```

浏览器打开 <http://127.0.0.1:7789/>（端口可用 `PORT` 环境变量改）。

- 端口 7789，只监听 `127.0.0.1`。`HOST=0.0.0.0` 之类的非回环地址会被直接拒绝启动：本服务把服务端的 key 借给页面用，对局域网开放等于把 key 交给同网段的任何设备，要这么用必须先有口令/鉴权机制（本期没做）。
- key 来源：环境变量 `DS_API_KEY` 优先，其次 `.secrets\api-key.txt`（单行，已被 .gitignore 忽略）。两处都没有时服务照常启动，静态页面能开，代理路由返回 503 并说明怎么配；`GET /api/health` 里只有 `keyConfigured: true/false`，不回显 key。
- 为什么 key 不进前端：`dist/` 是明文静态资源，谁拿到 JS 谁就拿到 key。所以网页版改成「浏览器不带鉴权头，服务端注入 `x-api-key`」：`src/services/localService.ts` 启动时探测 `GET /api/health`，命中就改用相对路径 `/anthropic/...`；APK（`https://dsapp.local`）与 `file://` 下探测直接为 false，行为与以前一致，不需要第二套构建产物。
- 跨站防护：代理路由校验 `Origin`（存在且与本服务不同源 → 403，挡「任意网页借 127.0.0.1 白嫖 key」）与 `Host`（只认回环，挡 DNS rebinding）；请求体上限 20 MB，超限 413（同步路由是 32 MB，与 sync-server 一致）。
- 同步路由：`/sync/api/{health,state,sync}` → `http://127.0.0.1:7788/api/{health,state,sync}`，方法、请求体与口令头原样透传，不注入任何凭据；`SYNC_UPSTREAM` 只允许指向回环地址。同步服务没起来时这条路由回 **502** 并带中文原因（`{"error":{"type":"sync_upstream_down",…}}`），设置页显示「同步服务未启动」而不是裸 fetch 错。它刻意不直接读 `sync-server/data/sync-data.json`：那份 JSON 已有两个写者（7788 与 lan-peer），再加一个会静默覆盖别人刚写的记录。
- 开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-web.vbs` 用无窗口的 Windows PowerShell 5.1 调 `local-server\start.ps1`（与 `dsh-desktop-autostart.vbs` 同一套范式：双日志、改扩展名即禁用）。关掉自启就把该文件改名成 `.vbs.disabled`。日志在 `local-server\logs\`：`start.log`（启停结果）、`server.log`（服务日志，2 MB 轮转）。
- 用默认 `build`（带 key）的产物起服务时，页面顶部会出现一条可关闭的黄色提示条「当前页面携带内置 API Key，仅建议本机自用」——提醒这份产物把 key 发给每个能打开页面的人；`build:web` 的产物没有这条。
- ⚠ `build:web` 产出的 `dist/` **不含 key**。打 APK 前必须用默认的 `pnpm --config.shell-emulator=true build` 重新构建，否则 `tools\build-apk.ps1` 第 0 步会拦住并提示这条命令（不会静默打出一个没 key 的包）。

## 安卓 APK

同一份 `dist/` 也可以打成可安装的 APK：前端资源放进 APK 的 assets，由 WebView 以虚拟源 `https://dsapp.local` 供给（真正的安全源，localStorage 与 IndexedDB 都可用）。零 Gradle、零 Maven，链路是 aapt2 → javac → d8 → jar → zipalign → apksigner，由 `tools/build-apk.ps1` 驱动（Windows，PowerShell 7）。

```powershell
.\tools\setup-toolchain.ps1                     # 一次性：JDK 17 + build-tools 35.0.1 + android-35 装到 %USERPROFILE%\.devtools
pnpm --config.shell-emulator=true build       # 前端 -> dist/
.\tools\build-apk.ps1                          # -> dist-apk\deepseek-chat.apk
.\tools\verify-apk.ps1                         # 34 项产物校验
adb install -r dist-apk\deepseek-chat.apk
```

- API Key **可以在构建期写入产物**：把 key 放进 `.secrets/api-key.txt`（单行，已被 .gitignore 忽略），下一次 `pnpm build` 会把它注入主包 —— 这样 APK 与网页版装好/打开即可用，不必先配置。没有该文件时构建回退到原流程：在设置里填，存在应用源的 localStorage 里。设置里手填的 key 始终优先于内置值，`tools\verify-apk.ps1` 会把包里的 key 与密钥文件比对（日志只打指纹，不打 key 本身）。**本机 Web 服务用的 `build:web` 刻意不注入 key**（见上一节），打 APK 时要用默认的 `pnpm build`。
- 包名沿用 `ds.app`，签名私钥是 `android\debug.keystore`（已 gitignore），因此新包能**覆盖升级**已装版本。丢了这份私钥就只能先卸载，本地聊天记录会一起丢。
- `versionName` 取自 `package.json`；`versionCode` 按 `major*10000 + minor*100 + patch` 折算（0.3.0 → 300）。发版前先改 `package.json`。
- `minSdk 26`、`targetSdk 34`（升到 35 会被 Android 15 强制 edge-to-edge），权限只有 `INTERNET` 与 `CHANGE_WIFI_MULTICAST_STATE` 两条（后者是手机直连收广播用的组播锁，normal 级，安装即授予）。
- `android/` 是壳层：`MainActivity.java`（assets 供给、外链、选文件、SAF 导出、返回键）、`LanLink.java`（手机直连的 UDP 广播 + TCP 收发）、`shell.js`（页面侧补丁：返回键、blob 导出、旧 WebView 的运行时 polyfill；由 `serveAsset` 插成入口 HTML `<head>` 最前面的同步脚本，先于 defer 主包执行）、`res/`、`AndroidManifest.xml`。
- 旧 WebView（实测 WebView 91）缺 Mermaid 依赖需要的新语法（产物里有 `class` 静态块），解析到那个 chunk 时会抛 SyntaxError。`src/services/markdown/mermaid.ts` 因此先做能力探测：不支持时图表按普通代码块显示并标注「当前环境不支持图表渲染」，连 mermaid 的 chunk 都不请求；支持时行为不变（照旧懒加载）。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm build:web` | 构建到 `dist/`，不含内置 key（本机 Web 服务用） |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，可在对话页输入区或设置 → 通用设置里切换模型（两处改的是同一个设置）；推理强度按 `output_config.effort` 传 `low` / `high` / `max`（默认 `high`），关闭深度思考时不传该字段。通过 Anthropic 兼容的 Messages / Files API 通信。请求的 `system` 字段取自设置 → 系统提示词里选中的那条（未选中时用内置默认项），切换只影响之后的请求，不改写已保存的消息。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    sync/              多端同步（HTTP 通道 + 手机直连局域网 P2P）；
                       设置 / 提示词 / 选中项的落地在 sync/local.ts
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
