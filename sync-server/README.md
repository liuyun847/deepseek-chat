# sync-server（多端同步服务，M1）

零依赖的本地同步服务：只用 Node.js 内置模块（`node:http` / `node:https` / `node:fs` / `node:path`）。
数据存成一个 JSON 文件，客户端通过 HTTPS 拉全量、推变更。

## HTTPS 与证书指纹（自签证书怎么配对）

首次运行先生成一张自签证书（需要 `openssl`；`start.ps1` 会自动去 Git for Windows 等常见安装位置找，
不必先在 PATH 里，见下面「HTTPS 与反代的先后顺序」）：

```powershell
node sync-server\gen-cert.mjs
```

证书与私钥落在 `sync-server\tls\`（已被 `.gitignore` 忽略）。然后把两者传给服务：

```powershell
node sync-server\server.mjs --tls-cert sync-server\tls\cert.pem --tls-key sync-server\tls\key.pem
```

不传 `--tls-cert/--tls-key` 时仍可跑明文 HTTP（行为与以前完全一致），但只建议回环调试；
局域网明文会在启动时打印警告。

### 指纹是什么、从哪看

服务端用「证书 DER 的 SHA-256」当唯一身份，格式固定为 **64 位小写十六进制、无分隔符**
（唯一实现在 `sync-server/cert-fingerprint.mjs`，与 Android `MainActivity.onReceivedSslError`
的判据逐字节等价）。同一个值有四处能看到，内容完全一致：

| 位置 | 说明 |
| --- | --- |
| 启动日志 | `[sync] 证书 SHA-256 指纹：…`（只打印指纹，私钥与证书内容一律不打印） |
| `node sync-server/gen-cert.mjs` | 生成与复用证书时都会打印 |
| `GET /api/health`、`GET /` 的 `certFingerprint` | 明文 HTTP 下为 `null`；旧字段名 `tlsFingerprint` 同值保留（向后兼容） |
| `POST /api/group/create`、`POST /api/group/invite` 的 `certFingerprint` | 只有管理端/主机走得到（沿用现有权限模型）；电脑上的页面靠它显示并复制 |

> 手机在固定指纹之前**连不上**本服务：WebView 对自签证书直接 `handler.cancel()`，
> 不允许 TOFU。所以手机拿不到接口里的指纹 —— 它必须人工抄/扫码带入。
> 接口里那份是给电脑页面显示与复制用的。

### 手机怎么带入（第一次配对）

1. 电脑上 `node sync-server\gen-cert.mjs`（或 `start.ps1`，它在缺证书时自动生成；
   但 7789 本机服务已在跑时会跳过，见「HTTPS 与反代的先后顺序」），
   从输出里抄下 64 位指纹；也可以在 `local-server` 托管的页面里
   设置 → 多端同步 →「测试连接」，读回服务端上报的指纹并用同一行的「复制」按钮复制。
2. 手机 APK → 设置 → 多端同步：
   - 服务地址填 `https://<电脑IP>:7788`（非回环地址只接受 HTTPS）；
   - 在「服务端证书指纹」一行粘贴那 64 位指纹 → 点「保存指纹」（可带冒号/空格与大小写，
     会被规范成小写无分隔符）。它通过 `window.__dsSync.setTlsPin()` →
     `Bridge.setSyncTlsPin` 写进原生 SharedPreferences，**进程重启后仍然有效**。
3. 再点「测试连接」，通了再创建组或用配对码加入。
4. 电脑建组后点「生成配对码」，页面会把指纹一并显示在配对码下面，方便再抄一次。

没固定指纹时的表现是可预期的（不是一句含糊的「连不上」）：

- 「服务端证书指纹」一行直接显示红字：
  「本机还没固定这个服务的证书指纹，自签 HTTPS 会被系统直接拒绝。请到运行 sync-server 的电脑上看启动日志或设置页里的指纹，复制过来填上，再点「测试连接」。」
- 点「测试连接」/「立即同步」/「创建组」/「加入组」会直接报
  「本机还没有固定这个同步服务的证书指纹…」—— 判断在发请求之前就做了，不会撞一个 TLS 失败。
- 浏览器里没有指纹桥：这一行会显示「浏览器里没有证书固定能力…」，复制按钮照常可用
  （网页同步由本机服务校验 CA 或浏览器信任链负责，见根目录 README）。

### 证书轮换（换 IP、换主机名、过期重签）

1. `node sync-server\gen-cert.mjs --force` 重新生成（或删掉 `sync-server\tls\` 后重跑）。
2. 指纹随之改变 —— 每台手机里旧的 pin 从此不匹配，自签证书会被一律 cancel（同步表现为失败）。
3. 每台手机重做上面第 2 步：粘贴新指纹 →「保存指纹」。
4. 反代（`local-server`）用 `SYNC_CA_FILE` 的话换掉 `cert.pem` 即可；用
   `SYNC_FINGERPRINT` 的要把那串一并改掉。

### 命令行自检（不用手机也能验三条判据）

`tools/tls-pin-sim.mjs` 用 Node 复刻 `onReceivedSslError` 的判断（没有 pin 拒、错 pin 拒、
对 pin 通），默认打 `/api/health`，退出码区分结论：

```sh
# 0=accept 2=没有 pin 被拒 3=指纹不匹配被拒
node tools/tls-pin-sim.mjs --url https://127.0.0.1:7788            # 期望 2
node tools/tls-pin-sim.mjs --url https://127.0.0.1:7788 --pin <64 位指纹>   # 期望 0
node tools/tls-pin-sim.mjs --url https://127.0.0.1:7788 --pin 0000...0000  # 期望 3
```

## 启动

Windows 上建议用脚本（幂等；只有 `GET /api/health` 报出 `format=chat-demo-sync` 才返回 0）。
`start.ps1` 会优先使用 `tls\cert.pem` + `tls\key.pem`，缺失时尝试自动生成
（生成机率受下面「HTTPS 与反代的先后顺序」那一节约束）：

```powershell
.\sync-server\start.ps1        # 隐藏窗口启动，默认 127.0.0.1:7788；-Port / SYNC_PORT 改端口
.\sync-server\start.ps1 -Lan   # 对局域网开放（= --host 0.0.0.0 + 必需口令），默认关闭
.\sync-server\stop.ps1         # 按端口停止，幂等
```

### HTTPS 与反代的先后顺序（为什么 7789 在跑时不自动生成）

本机 Web 服务（`local-server`，默认 7789）是在**它自己启动时**一次性采样 `sync-server\tls\cert.pem`
来决定上游协议的（有证书 → `https://127.0.0.1:7788` + `SYNC_CA_FILE`，没有 → 明文 http），
进程起来之后不会跟随。所以「证书中途出现」会让它拿 http 客户端去打一个 TLS 端口，`/sync/api/*` 直接 502。

`start.ps1` 因此多了一条判断：探测到 7789 已在监听、且当前没有证书时，**跳过自动生成**，
只打印切换步骤（服务照常以 HTTP 起来，浏览器同步不受影响）。要切 HTTPS，按这个顺序：

```powershell
.\local-server\stop.ps1            # 先停反代，别让它带着 http 上游留在那儿
node sync-server\gen-cert.mjs      # 生成证书并打印 64 位指纹（手机要 pin 的那串）
.\sync-server\start.ps1            # 7788 起来就是 HTTPS
.\local-server\start.ps1           # 7789 这次会自动选 https 上游 + SYNC_CA_FILE
```

开机自启（两个 vbs 并行拉起）两种先后顺序都能收敛：sync 先跑 → 生成证书、7788 走 HTTPS，
local-server 后起时会看到证书并自动用 https 上游；local-server 先跑 → 7788 探测到 7789 在监听，
跳过生成、保持 HTTP，两边仍然配对。

> 顺带一句：自签 HTTPS 下的 `/api/health` 探测走 `curl -k`（Windows 10 1803+ 自带），
> 因为 PowerShell 5.1/7 的脚本块没法做证书回调（回调跑在 TLS 线程上、没有 Runspace，设了也照样握手失败）。

### 对局域网开放：`-Lan`（默认关闭）

「自启只监听回环」这条不变：开机自启的 vbs 不带 `-Lan`。
手机要直连这个 HTTPS 端口（见「二维码配对串」一节）时才显式开放：

| 参数 | 作用 |
| --- | --- |
| `-Lan` | 等价 `--host 0.0.0.0`。**口令三处必有一处**，否则脚本拒绝启动（退出码 1）：`-Token <口令>` > `SYNC_TOKEN` 环境变量 > `<仓库>\.secrets\sync-token.txt` 首行 |
| `-Token <口令>` | 本次用的口令；只在 `-Lan` 时生效（不给 `-Lan` 会打一行提示，仍只监听回环） |
| `-PublicHost <host:port>` | 透传给 `--public-host`：二维码里就用这个地址（反代 / 端口映射 / 域名场景） |

口令**不进命令行**：`start.ps1` 把它放进子进程的 `SYNC_TOKEN` 环境变量，
所以进程列表与 `start.log` 里都看不到它；日志只说「口令已启用」。
开放成功时日志里会明确出现这一行（看不到就说明仍是回环模式）：

```text
[sync] 已对局域网开放：0.0.0.0:7788，口令已启用（未打印）
```

服务端自身也会再打一行 `[sync] 已对局域网开放：监听 0.0.0.0（口令已启用…）`。
第一次开放前先准备一份口令（生成即用，不打印到历史记录里）：

```powershell
New-Item -ItemType Directory -Force .secrets | Out-Null
[System.IO.File]::WriteAllText("$PWD\.secrets\sync-token.txt", [guid]::NewGuid().ToString('N'))
.\sync-server\start.ps1 -Lan
```

已有一实例在跑时脚本**不会替你重启**（它只做幂等检查）：要切到局域网模式得先
`stop.ps1` 再 `start.ps1 -Lan`，脚本会打一行提示说明这一点。

开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-chat-sync.vbs` 调一次 `start.ps1`，
日志在 `sync-server\logs\start.log`（启停结果）与 `logs\autostart.err.log`（那次隐藏运行的 stderr）。
服务本身只往 stdout 写，start.ps1 刻意不重定向（否则长驻的 node 会占住自启的 stderr 文件，见 start.ps1 文件头）。

手动前台运行（能直接看到服务日志）：

```sh
# HTTPS：自签证书
node sync-server/server.mjs --tls-cert sync-server/tls/cert.pem --tls-key sync-server/tls/key.pem

# 指定端口 / 数据文件 / 局域网监听（局域网务必配 TLS + token）
node sync-server/server.mjs --port 7788 --data D:\sync\chat.json --host 0.0.0.0 \
  --tls-cert sync-server/tls/cert.pem --tls-key sync-server/tls/key.pem --token <口令>

# 手机扫码配对（二维码里的地址由服务端拼；反代/端口映射场景用 --public-host 显式指定）
node sync-server/server.mjs --host 0.0.0.0 --token <口令> --tls-cert sync-server/tls/cert.pem \
  --tls-key sync-server/tls/key.pem --public-host 192.168.1.5:7788
```

**监听非回环地址但没设口令时本进程拒绝启动**（不是警告）：那等于把整库会话交给局域网里任何一台机器。
默认只监听 `127.0.0.1`，本机自用不需要口令。

| 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--port` | `SYNC_PORT` | `7788` | 监听端口 |
| `--host` | `SYNC_HOST` | `127.0.0.1` | 监听地址；局域网内其它设备要连时用 `0.0.0.0`，**此时必须同时给 `--token`**，否则拒绝启动 |
| `--public-host` | `SYNC_PUBLIC_HOST` | 空（自动枚举网卡） | 二维码里的地址，形如 `192.168.1.5:7788`；反代 / 端口映射 / 域名这些服务端推不出来的场景用它，优先于自动枚举 |
| `--data` | `SYNC_DATA` | `sync-server/data/sync-data.json` | 数据文件（相对路径按当前工作目录解析） |
| `--name` | `SYNC_NAME` | 主机名 | 只在服务端日志里显示，不再对外返回 |
| `--token` | `SYNC_TOKEN` | 空（不鉴权） | 访问口令；设了之后 `/api/*` 必须带 `Authorization: Bearer <口令>` 或 `X-Sync-Token` |
| `--tls-cert` | `SYNC_TLS_CERT` | 空 | PEM 证书路径；与 `--tls-key` 同时给时启用 HTTPS |
| `--tls-key` | `SYNC_TLS_KEY` | 空 | PEM 私钥路径；与 `--tls-cert` 同时给时启用 HTTPS |
| `--allow-origin` | `SYNC_ALLOWED_ORIGINS` | 空 | 额外放行的跨域来源，逗号分隔，可重复给 |
| `--no-webview-origin` | — | 未给（= 放行） | 去掉 Android 外壳的 `https://dsapp.local` 来源 |

启动后终端会打印端口、数据文件路径、跨域白名单与口令状态（口令值本身不会打印）；未设口令时会多打一条醒目提示。`Ctrl+C` 会先落盘再退出。

## 接口

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok, format, version, time, tokenRequired, tls, certFingerprint, tlsFingerprint, records, sessions, messages, prompts, settings, tombstones }`（不含主机名与数据文件路径；`certFingerprint` 在明文 HTTP 下为 `null`，`tlsFingerprint` 是同值旧名） |
| GET | `/api/state` | — | `{ ok, format, version, time, records: SyncRecord[] }`（全量，含墓碑） |
| POST | `/api/sync` | `{ device, records }` | `{ ok, applied: { accepted, rejected }, collapsed, records: SyncRecord[] }`（合并后的全量） |
| GET | `/` | — | 自报身份、`certFingerprint` 与端点清单 |

## 组与配对

组信息存在数据文件同目录的 `group.json`（设备令牌只存 SHA-256，配对码一次性、10 分钟有效）。
创建组后，除 `GET /api/health`、`GET /api/group`、`POST /api/group/join` 外，`/api/state` 与 `/api/sync`
都需要设备令牌（`Authorization: Bearer <deviceToken>` 或 `X-Sync-Token`）。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/group` | — | `{ ok, group }`；未建组时 `group: null` |
| POST | `/api/group/create` | `{ device, name, groupName?, canHost? }` | `{ ok, group, deviceToken, invite:{ code, expiresAt }, certFingerprint, pair }`，仅未建组时可用 |
| POST | `/api/group/join` | `{ code, device, name, canHost? }` | `{ ok, group, deviceToken }`；配对码一次性 |
| POST | `/api/group/invite` | 需令牌 | `{ ok, invite:{ code, expiresAt }, certFingerprint, pair }`，仅主机 |
| POST | `/api/group/host` | `{ device, targetDeviceId, epoch }` + 令牌 | `{ ok, group }`；epoch 不匹配回 409 |
| POST | `/api/group/revoke` | `{ targetDeviceId }` + 主机令牌 | `{ ok, group }`；不能移除主机自己 |

`POST /api/sync` 可带 `epoch`；带旧 epoch 会回 409 `{ error:'epoch_stale', group }`，客户端刷新组信息后重试。
健康检查额外返回 `groupId`、`groupName`、`hostDeviceId`、`groupEpoch`、`groupDevices`。

`create` 与 `invite` 是唯一的「管理端」两条路（前者是建组引导、后者只允许主机调），
所以自签指纹只在这两处随配对码一起返回；`join` 不带 —— 加入方本来就被配对码鉴权，
而且它在固定指纹之前根本连不上本服务（原因见上文「HTTPS 与证书指纹」）。

> 主机是组内的管理角色；数据服务仍然由运行 `sync-server` 的那台机器提供。手机可以加入组、被指定为主机，
> 但要让手机真正提供同步服务，需要在 APK 里增加原生 host 运行时（见后续工作）。

### 二维码配对串（`pair`）

`create` 与 `invite` 两条响应里各多一个 `pair` 对象，给页面画二维码用：

```json
{
  "pair": {
    "uri": "deepseek-sync://pair?v=1&h=192.168.1.5:7788&c=ABCD2345&f=7a8bc5…ade3&x=1766000000",
    "host": "192.168.1.5:7788",
    "reachable": true,
    "reason": null,
    "candidates": ["192.168.1.5:7788"]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `uri` | 自描述串：`v` 协议版本（当前 `1`）、`h` 服务地址 `host[:port]`（省端口即 7788）、`c` 8 位配对码、`f` 证书 SHA-256（64 位小写十六进制，仅 HTTPS）、`x` 过期时间（Unix 秒） |
| `host` | `uri` 里用的地址；不可达时为 `null` |
| `reachable` | `false` 表示**这张码手机用不了**（页面据此改画一条能照做的说明，不画码） |
| `reason` | `loopback`（只监听回环）/ `no-address`（没找到可用网卡）/ `no-tls`（地址有了但服务没有 TLS 证书）/ `null` |
| `candidates` | 本机其它可用地址，第一项就是 `uri` 里那个 |

**串为什么由服务端拼**：网页永远在回环上（页面由 `local-server` 托管，只绑 127.0.0.1），
`location.origin` 恒为 `127.0.0.1:7789` —— 手机照着连等于连自己。只有服务端知道自己监听在哪、
这台机器有哪些网卡，所以页面只负责把 `uri` 画成矩阵。

**没有证书就一律不给码**（`reason=no-tls`）：手机端对非回环的明文地址是硬拒绝
（`src/services/sync/pairing.ts` 的 `plaintext` 分支），安卓壳也不允许 TOFU 自签证书 ——
所以 `--host 0.0.0.0 --token` 但不带证书时，串里根本没有 `f` 字段，画出来必然被扫后即拒。
这种部署要先把证书补上：`node sync-server/gen-cert.mjs`，再用 HTTPS 重启服务。
地址侧的毛病（`loopback` / `no-address`）优先于这条：默认部署两样都缺，最该说的是「开局域网模式」。

地址的挑法（实现在 `sync-server/pair-uri.mjs`，自检见 `tools/pair-qr-sim.mjs` 的 L4）：
显式给了 `--public-host` 就用它（并认为可达，反代场景正是这样）；否则监听在回环 → `reachable=false`；
监听在 `0.0.0.0` → 枚举网卡并**丢掉** `internal`、`169.254.*`（APIPA）与虚拟网卡
（VirtualBox `0a:00:27`/`08:00:27`、VMware `00:50:56`/`00:0c:29`/`00:05:69`、Hyper-V `00:15:5d`），
再按 `192.168.*` > `10.*` > `172.16-31.*` > 其它排序取第一名（本机有两块网卡，实测挑到的是真实的
`192.168.x.x`，不是 VirtualBox 的 `192.168.56.1`）。

安全边界没变：码仍是一次性 + 10 分钟 TTL（`f`/`x` 只是告诉手机「这张码是谁、到几点」），
二维码与 `invite.code` 是同一个码的两种呈现，服务端仍然只存 `codeHash`。`x` 过期由展示端撤图，
真正的闸在 `join` 的时间与哈希比对。

`OPTIONS` 返回 204 + CORS 头，允许 `GET` / `POST` / `Content-Type` / `Authorization` / `X-Sync-Token`；
来源通过白名单才回显 `Origin`，不通过直接 403 且不回任何 CORS 头（见下节「访问控制」）。
设了口令后 `/api/*` 缺失或错误口令回 401。
单次请求体上限 32 MB。

诊断命令与验收（复制即可跑，期望值写在注释里）：

```sh
# 下面假设已生成 sync-server/tls/cert.pem，并且服务以 --tls-cert/--tls-key 启动
curl --cacert sync-server/tls/cert.pem https://127.0.0.1:7788/api/health
curl --cacert sync-server/tls/cert.pem https://127.0.0.1:7788/api/state

# ① 同源来源：200，且带 Access-Control-Allow-Origin
curl -s -D - -o NUL -H "Origin: http://127.0.0.1:7788" http://127.0.0.1:7788/api/state

# ② 陌生来源：403，且没有 Access-Control-Allow-Origin（浏览器因此读不到响应）
curl -s -D - -o NUL -H "Origin: https://evil.example" http://127.0.0.1:7788/api/state
curl -s -D - -o NUL -X OPTIONS -H "Origin: https://evil.example" \
     -H "Access-Control-Request-Method: POST" http://127.0.0.1:7788/api/state

# ③ 开了口令之后：不带口令 401，带对了 200
curl -s -o NUL -w "%{http_code}\n" http://127.0.0.1:7788/api/state
curl -s -o NUL -w "%{http_code}\n" -H "Authorization: Bearer <口令>" http://127.0.0.1:7788/api/state
```

## 访问控制

| 来源 | 判定 |
| --- | --- |
| 没有 `Origin`（curl、本机脚本、同源导航） | 放行 |
| `http://127.0.0.1` / `http://localhost` / `http://[::1]`（**端口不限**） | 放行（网页伪造不出回环来源，dev server 8090、本地 Web 服务 7789 免配置） |
| 与请求 `Host` 严格同源（手机浏览器直连 `http://192.168.1.5:7788`） | 放行 |
| `https://dsapp.local`（Android 外壳的虚拟源；`--no-webview-origin` 可关） | 放行 |
| `--allow-origin` / `SYNC_ALLOWED_ORIGINS` 里列出的来源 | 放行 |
| 其它：任意公网域名、`Origin: null`（沙箱 iframe / data: / blob:）、端口不同的非回环来源 | **403，且不回任何 CORS 头** |

预检与真实请求走同一道闸，所以 `Content-Type: text/plain` 的跨站「简单请求」也写不进去。
设了口令之后，`/api/*`（含 `/api/health`）一律要求 `Authorization: Bearer <口令>` 或
`X-Sync-Token: <口令>`；口令不会出现在日志和响应体里，比对是定长的。

> 客户端（网页版）目前**不发送口令**，所以开了 `SYNC_TOKEN` 之后网页端同步会收到 401。
> 需要口令时请用 curl / 脚本访问；要让网页端也支持，得在 `src/services/sync/api.ts` 的请求里
> 加 `Authorization` 头并在设置里存口令（尚未实现）。

## 记录格式

```json
{
  "kind": "message",
  "id": "<消息 id>",
  "sessionId": "<所属会话 id>",
  "updatedAt": 1770000000000,
  "device": "dev-a1b2c3d4",
  "deletedAt": null,
  "data": { "id": "...", "role": "assistant", "parentId": "...", "blocks": [] }
}
```

- `kind` 共五种：
  - `session`：会话级元数据，不含 messages
  - `message`：完整消息对象，字段原样搬运
  - `settings`：整份可同步设置，`id` 固定 `device-agnostic`（一条记录装全部）
  - `prompt`：提示词库的每一条，`id` 即提示词 id，`data` 为 `{ id, name, content, createdAt }`
  - `prompt-selection`：当前选中的提示词，`id` 固定 `selected`，`data` 为 `{ selectedId }`（`null` = 内置默认）
- 主键是 `kind + ":" + id`
- `deletedAt` 非空即墓碑，此时 `data` 为 `null`；只有 `session` / `message` / `prompt` 会墓碑化，
  `settings` 与 `prompt-selection` 是「永远存在」的整份记录，墓碑一律按非法记录拒绝
- `device` 只用于 `updatedAt` 撞车时的 tie-break
- 校验是白名单式的：`settings` 的 `data` 只保留十个字段（语言、主题、字号、位置、模型、
  推理强度、深度思考、智能搜索、侧边栏、同步服务地址），`apiKey`、`syncDeviceId`、
  `syncDeviceName`、LAN 相关键即使被客户端塞进来也会在落盘前消失（数据文件里不可能出现
  API Key，也不会有设备名 —— 设备名是本机身份，不跨端覆盖）

## 合并规则

1. `updatedAt` 大者胜；相同则 `device` 字符串大者胜（两端算出的赢家一致，不会永久分叉）
2. 会话已删除时，它名下的消息一律墓碑化；墓碑字段只由会话墓碑推导，保证各端结果一致
3. 服务端与客户端必须是同一套规则：本文件 `compareRecords` / `collapseDeletedSessions` 与
   `src/services/sync/merge.ts` 逐条对应，改一侧要同步改另一侧

## 限制（M1）

- 默认无口令：没设 `SYNC_TOKEN` / `--token` 时，能访问该端口的人都能读写全部会话，启动日志会
  打印醒目提示。跨站来源默认被拒（白名单见「访问控制」），「浏览器里随便一个网页就能读走会话」
  这条路已封；M2 若要跨不可信网络，开 `SYNC_TOKEN` 或走隧道。
- 不清理墓碑（删除记录会一直留着，用于防止复活）；量大了需要手工清理数据文件。
- 只同步会话与消息的文本/结构，不同步附件原件（图片等）；设置里的 API Key、设备 id、
  设备名不在同步范围内，只留在各设备本机。
- 单进程、单文件：并发写入靠 Node 单线程串行，够个人多端使用，不是多实例集群方案。

## 数据文件

```json
{ "format": "chat-demo-sync", "version": 2, "updatedAt": 0, "records": { "session:<id>": { ... } } }
```

写入是先写 `*.tmp` 再 rename 的原子替换；进程被强杀最多丢掉最后一次尚未落盘的写入（去抖 200ms）。

**数据文件被外部更新后不需要重启本服务**：`/api/health`、`/api/state`、`POST /api/sync` 处理前会
先 `stat` 一次（`mtimeMs`+`size`，只 stat 不读内容），指纹变了才重读文件并按 LWW **并进**内存
（是合并，不是整份替换，因此不会盖掉内存里刚接受、还没落盘的记录），然后照常处理请求。
覆盖的场景：手工编辑数据文件、
另一个实例写过。读出问题（正被原子 rename 替换时 Windows 会给 `EBUSY`/`EPERM`）最多重试 3 次、
每次 15ms，3 次都失败就先用内存视图应答（不 500、不空响应），下次请求再对账。
落盘失败（rename 撞上外部写）同样有限重试：10 秒窗口内每 200ms 再试一次。

## 协议版本

当前 `version` 为 2（v1 → v2 新增 `settings` / `prompt` / `prompt-selection` 三种记录）。
只升级一侧时的表现都是「明确报错」，不会静默写坏数据：

- 旧客户端（v1）× 新服务端（v2）：客户端发现服务端版本更大，拒绝同步并提示升级页面
- 新客户端（v2）× 旧服务端（v1）：旧服务端不认新 kind，整批推送被判非法并回 400

老数据文件（只有 session / message）可以直接被 v2 服务端载入：未知/缺失的新 kind 只是 0 条。
