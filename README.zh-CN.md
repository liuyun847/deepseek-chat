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
node sync-server\gen-cert.mjs                # 首次：生成自签证书到 sync-server\tls\
.\sync-server\start.ps1                      # 启动（HTTPS，隐藏窗口，端口 7788；用 -Port 或 SYNC_PORT 改）
.\sync-server\stop.ps1                       # 按端口停止，幂等
node sync-server/server.mjs --tls-cert sync-server\tls\cert.pem --tls-key sync-server\tls\key.pem  # 或前台跑，看服务输出
```

日志：`sync-server\logs\start.log`（启停结果）。服务本身只往 stdout 写，start.ps1 刻意不做重定向（原因写在 start.ps1 文件头：一旦重定向，长驻的 node 会占住开机自启的 stderr 文件，下次登录那次自启就变成静默空转）。

默认只监听 `127.0.0.1`，数据写在 `sync-server/data/sync-data.json`；局域网内其它设备要连时用 `--host 0.0.0.0`，保留 TLS、配 `--token`，并把本机 HTTPS 地址填进客户端。客户端在 设置 → 多端同步 里填服务地址（例如 `https://192.168.1.5:7788`）、设备名，然后「测试连接」→「立即同步」。非回环的明文 `http://` 地址会被客户端拒绝。

本机 Web 服务通过 `SYNC_CA_FILE` 信任这张自签证书（`local-server/start.ps1` 会自动找 `sync-server/tls/cert.pem`）；浏览器只访问回环页面，看不到自签证书。页面上的地址留空即可走同源 `/sync/api/*`，由本机服务转发到 `https://127.0.0.1:7788`。

由 `local-server` 托管的浏览器页面（见下一节）可以**留空**：同步自动走同源 `/sync/api/*`，由本机服务转发到 `https://127.0.0.1:7788`，于是手机同步来的会话零配置就能看到。填了地址则优先用填的那台。

**自签 HTTPS 在手机上要多一步：把证书指纹固定到设备里。** 安卓壳对自签证书一律拒绝，只有在设备上固定过服务端证书的 SHA-256 指纹时才放行（`onReceivedSslError` 里其余情况直接 cancel，不允许 TOFU）。这一串 64 位小写十六进制在四个地方完全一致：服务启动日志、`node sync-server/gen-cert.mjs` 的输出、`GET /api/health` 与 `GET /` 的 `certFingerprint`、以及建组/生成配对码响应里的 `certFingerprint`（电脑上的页面会显示它并给一个**复制**按钮）。把它粘贴到 设置 → 多端同步 →「服务端证书指纹」→「保存指纹」：冒号、空格与大小写都会被规范化，页面通过 `window.__dsSync.setTlsPin()` → `Bridge.setSyncTlsPin` 交给原生，写进 SharedPreferences，**进程重启后仍然有效**。没固定之前设置页会显示红字提示，测试连接/同步/建组都会给出明确文案，而不是一句含糊的「连不上服务」。换证书（`gen-cert.mjs --force`）会改变指纹，每台手机都要重新固定一次。浏览器里没有这座桥：网页同步由本机服务校验 CA 文件或浏览器信任链负责。想不拿手机就验「没 pin / 错 pin / 对 pin」三种情况，跑 `node tools/tls-pin-sim.mjs --url https://<主机>:7788 [--pin <指纹>]`（退出码 0 通过 / 2 没 pin 被拒 / 3 指纹不匹配）。

**扫码配对（二维码）**：「同步组」面板里建组或点「生成配对码」后，配对码上方会多一张「扫码配对」卡片 —— 内联 SVG（不是弹窗，手机要对着屏幕扫）、白底黑块、10 分钟倒计时。码里放的是服务端拼好的自描述串 `deepseek-sync://pair?v=1&h=<地址:端口>&c=<配对码>&f=<证书指纹>&x=<过期秒>`：**扫一张码就把服务地址、配对码、证书指纹三件套一起带进手机**，不用再手抄指纹。三条要紧的规矩：

- 它是一次入组的**完整凭据**（等同于密码），有效期 10 分钟、一次性；不要截图外发、不要贴进在线二维码生成器。展示端在 `x` 到期时会把 SVG 从页面上撤掉（换成「已过期 + 重新生成」），避免把人骗去扫一张早就失效的码。
- 二维码里的地址**只能由服务端给**：网页永远在回环上（`127.0.0.1`），拿 `location.origin` 拼出来的地址手机连上去等于连自己。服务端在 `create`/`invite` 的响应里带 `pair.uri`，页面只负责画矩阵。
- **默认部署下这张码画不出来**：`start.ps1` 不传 `--host`，服务只监听回环，卡片会改成一条能照做的命令。要手机直连，用局域网模式重启：`node sync-server/server.mjs --host 0.0.0.0 --token <口令>`（局域网**必须**配口令，没口令时服务端直接拒绝启动；反代/端口映射/域名场景再加 `--public-host 192.168.1.5:7788` 指定手机该连哪里）。等价的一步到位写法是 `.\sync-server\start.ps1 -Lan`（默认关闭；口令按 `-Token` > `SYNC_TOKEN` > `.secrets\sync-token.txt` 的顺序找，三处都没有就拒绝启动），日志里会明确出现 `已对局域网开放`。中继式部署里手机连不上时，卡片也会给出这条命令而不是给一个连不上的地址。反过来，服务端**没有 TLS 证书**时（`pair.reason` 为 `no-tls`）卡片不会画码，只提示「先在服务端生成证书再配对」—— 手机端对非回环的明文地址是硬拒绝，那种码扫了也白扫。

配对串的解析器只有一份且在 TypeScript 里（`src/services/sync/pairing.ts`，可脱离浏览器测），扫码回填复用它；格式的编解码自检跑 `node tools/pair-qr-sim.mjs`（L1 解析 + L2 矩阵黄金向量 + L4 服务端选地址 + 旧 WebView 回归，退出码 0 通过）与 `node tools/pair-qr-sim.mjs --parse "<串>"`（打印解析出的地址/码/指纹/过期时间）。

**手机这一侧（扫码 / 从图片 / 粘贴串）**：设置 → 多端同步 → 「扫码配对」卡片，三条路都走同一个解析器，成功后弹一张确认卡，把「服务地址 / 配对码 / 证书指纹 / 有效期」摊开，点「配对并加入」才真正入组：

1. **扫描二维码**（APK 内才有）：调起原生 `ScanActivity`（Camera2 预览 + ZXing 解码）；拒绝相机权限或设备没有摄像头时，那条路自动降到下面两条，不崩。
2. **从图片选择**：扫码界面里点「从图片选择」，走系统文件选择器取一张二维码图（`BitmapFactory` 解码后交给同一个解码类）。屏幕反光/贴膜扫不出来时用它，也是**没有真机时唯一能走通整条链路的入口**。
3. **粘贴配对串**：把电脑上「复制配对串」得到的 `deepseek-sync://…` 粘进输入框点「解析」。网页版（浏览器）只有这一条路。

顺序是硬要求：**先写证书指纹、再 `joinGroup`**。WebView 在 TLS 握手阶段就拒自签证书，写晚了的表现是「第一下必然失败、第二下就好了」。失败文案按解析器的 `reason` 逐条不同（串太长 / 不是本应用的码 / 版本不认识 / 地址不合法 / 明文非回环 / 配对码字符不对 / 指纹不是 64 位 / 已过期），不是一句笼统的「配对失败」。

解码这一段可以脱离真机验：`.\tools\qr-decode-check.ps1`（UTF-8 BOM 的 .ps1）用 **APK 里同一份 `QrDecode.java`** 在桌面 JVM 上跑 `tools\qr-samples\` 的 4 张固定样本，**两条路径都跑**（`RGBLuminanceSource` 图库路径、带 `rowStride` 填充的 Y 平面相机路径），逐字符比对后再过一遍解析器。样本由 `node tools/qr-samples/generate.mjs` 用页面同一个编码器生成（含本项目的配对串与一张反例）。

数据文件被外部更新后**不需要重启 sync-server**：它在 `/api/health`、`/api/state`、`POST /api/sync` 处理前先 stat 一次，发现被别处写过就重读并按 LWW 并进内存——手机 P2P 推来的会话因此立刻能在浏览器看到。

开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-sync.vbs` 每次登录用无窗口的 Windows PowerShell 5.1 跑一次 `sync-server\start.ps1`（与下一节的 Web 服务同一套范式；改名成 `.vbs.disabled` 即关闭，它自己的 stderr 落在 `sync-server\logs\autostart.err.log`）。自启时只监听 `127.0.0.1:7788`，手机走 P2P（`lan-peer`）到这台电脑，不经过这个端口；**只有显式用 `--host 0.0.0.0 --token <口令>` 重启时它才监听局域网**，那时手机既可以走 P2P、也可以直接连这个 HTTPS 端口（见下面的扫码配对）。

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
- 同步路由：`/sync/api/{health,state,sync}` → `https://127.0.0.1:7788/api/{health,state,sync}`，方法、请求体与口令头原样透传；请求没带 `Authorization` / `X-Sync-Token` 时补一个 `Bearer <口令>`（读 `.secrets/sync-token.txt` 首行，其次 `SYNC_TOKEN`）—— 局域网模式下 7788 的 `/api/*` 全要口令，页面这边因此不用手抄口令，自带设备令牌时一律不动它；`SYNC_UPSTREAM` 只允许指向回环地址。上游是自签证书时用 `SYNC_CA_FILE`（推荐）或 `SYNC_FINGERPRINT` 做校验。同步服务没起来时这条路由回 **502** 并带中文原因（`{"error":{"type":"sync_upstream_down",…}}`），设置页显示「同步服务未启动」而不是裸 fetch 错。
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
- `minSdk 26`、`targetSdk 34`（升到 35 会被 Android 15 强制 edge-to-edge），权限**正好三条**：`INTERNET`、`CHANGE_WIFI_MULTICAST_STATE`（手机直连收广播用的组播锁，normal 级，安装即授予）、`CAMERA`（扫码配对，dangerous 级，**第一次点「扫描二维码」时才弹系统对话框**）。相机不是安装前提：清单里 `uses-feature android.hardware.camera required="false"`，没有摄像头的设备照样能装，扫码界面会直接给「从图片选择」；拒绝授权也不崩，同一条路照走。`tools\verify-apk.ps1` 对「正好 3 条 / 已声明 CAMERA / 相机非必需」各有一条断言。
- **唯一的第三方二进制**：`android\libs\zxing-core-3.5.3.jar`（Apache-2.0，只用来把相机帧/图片解成二维码字符串，见 [android/libs/README.md](android/libs/README.md)）。这是「不引任何第三方库（含 AndroidX）」这条原则的**唯一例外**：它是 plain jar（无 AAR、无资源、无传递依赖），只需在 `tools\build-apk.ps1` 的 `javac -classpath` 与 `d8` 输入里带上，零 Gradle 约束完全保住。代价是 `classes.dex` 从 42 KB 涨到约 590 KB（APK 内压缩后 +274 KB），APK 整体 1.87 → 2.15 MB；阶段 2 的 M4（`ScanActivity` + `QrDecode`）在这个基础上再加约 22 KB dex。许可全文随包放在 `android\libs\LICENSE-APACHE-2.0.txt`（Apache-2.0 第 4 条要求随分发附带），分发 APK 时请一并保留。
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
