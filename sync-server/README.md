# sync-server（多端同步服务，M1）

零依赖的本地同步服务：只用 Node.js 内置模块（`node:http` / `node:https` / `node:fs` / `node:path`）。
数据存成一个 JSON 文件，客户端通过 HTTPS 拉全量、推变更。

## HTTPS（默认建议）

首次运行先生成一张自签证书（需要 PATH 里有 `openssl`）：

```powershell
node sync-server\gen-cert.mjs
```

证书与私钥落在 `sync-server\tls\`（已被 `.gitignore` 忽略）。然后把两者传给服务：

```powershell
node sync-server\server.mjs --tls-cert sync-server\tls\cert.pem --tls-key sync-server\tls\key.pem
```

服务会在启动日志里打印证书 SHA-256 指纹，并把它放进 `GET /api/health` 的 `tlsFingerprint`。
客户端用同一个证书做校验（`SYNC_CA_FILE`）或指纹固定（`SYNC_FINGERPRINT`）。
不传 `--tls-cert/--tls-key` 时仍可跑明文 HTTP，但只建议回环调试；局域网明文会打印警告。

## 启动

Windows 上建议用脚本（幂等；只有 `GET /api/health` 报出 `format=chat-demo-sync` 才返回 0）。
`start.ps1` 会优先使用 `tls\cert.pem` + `tls\key.pem`，缺失时尝试自动生成：

```powershell
.\sync-server\start.ps1        # 隐藏窗口启动，默认 127.0.0.1:7788；-Port / SYNC_PORT 改端口
.\sync-server\stop.ps1         # 按端口停止，幂等
```

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
```

| 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--port` | `SYNC_PORT` | `7788` | 监听端口 |
| `--host` | `SYNC_HOST` | `127.0.0.1` | 监听地址；局域网内其它设备要连时用 `0.0.0.0` |
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
| GET | `/api/health` | — | `{ ok, format, version, time, tokenRequired, tls, tlsFingerprint, records, sessions, messages, prompts, settings, tombstones }`（不含主机名与数据文件路径） |
| GET | `/api/state` | — | `{ ok, format, version, time, records: SyncRecord[] }`（全量，含墓碑） |
| POST | `/api/sync` | `{ device, records }` | `{ ok, applied: { accepted, rejected }, collapsed, records: SyncRecord[] }`（合并后的全量） |
| GET | `/` | — | 自报身份与端点清单 |

## 组与配对

组信息存在数据文件同目录的 `group.json`（设备令牌只存 SHA-256，配对码一次性、10 分钟有效）。
创建组后，除 `GET /api/health`、`GET /api/group`、`POST /api/group/join` 外，`/api/state` 与 `/api/sync`
都需要设备令牌（`Authorization: Bearer <deviceToken>` 或 `X-Sync-Token`）。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/group` | — | `{ ok, group }`；未建组时 `group: null` |
| POST | `/api/group/create` | `{ device, name, groupName?, canHost? }` | `{ ok, group, deviceToken, invite:{ code, expiresAt } }`，仅未建组时可用 |
| POST | `/api/group/join` | `{ code, device, name, canHost? }` | `{ ok, group, deviceToken }`；配对码一次性 |
| POST | `/api/group/invite` | 需令牌 | `{ ok, invite:{ code, expiresAt } }`，仅主机 |
| POST | `/api/group/host` | `{ device, targetDeviceId, epoch }` + 令牌 | `{ ok, group }`；epoch 不匹配回 409 |
| POST | `/api/group/revoke` | `{ targetDeviceId }` + 主机令牌 | `{ ok, group }`；不能移除主机自己 |

`POST /api/sync` 可带 `epoch`；带旧 epoch 会回 409 `{ error:'epoch_stale', group }`，客户端刷新组信息后重试。
健康检查额外返回 `groupId`、`groupName`、`hostDeviceId`、`groupEpoch`、`groupDevices`。

> 主机是组内的管理角色；数据服务仍然由运行 `sync-server` 的那台机器提供。手机可以加入组、被指定为主机，
> 但要让手机真正提供同步服务，需要在 APK 里增加原生 host 运行时（见后续工作）。

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
  设备名与手机直连的口令不在同步范围内，只留在各设备本机。
- 单进程、单文件：并发写入靠 Node 单线程串行，够个人多端使用，不是多实例集群方案。

## 数据文件

```json
{ "format": "chat-demo-sync", "version": 2, "updatedAt": 0, "records": { "session:<id>": { ... } } }
```

写入是先写 `*.tmp` 再 rename 的原子替换；进程被强杀最多丢掉最后一次尚未落盘的写入（去抖 200ms）。

**数据文件被外部更新后不需要重启本服务**：`/api/health`、`/api/state`、`POST /api/sync` 处理前会
先 `stat` 一次（`mtimeMs`+`size`，只 stat 不读内容），指纹变了才重读文件并按 LWW **并进**内存
（是合并，不是整份替换，因此不会盖掉内存里刚接受、还没落盘的记录），然后照常处理请求。
覆盖的场景：手机把记录 P2P 推给 `lan-peer` 后它原子写了同一份 JSON、手工编辑数据文件、
另一个实例写过。读出问题（正被原子 rename 替换时 Windows 会给 `EBUSY`/`EPERM`）最多重试 3 次、
每次 15ms，3 次都失败就先用内存视图应答（不 500、不空响应），下次请求再对账。
落盘失败（rename 撞上外部写）同样有限重试：10 秒窗口内每 200ms 再试一次。

## 协议版本

当前 `version` 为 2（v1 → v2 新增 `settings` / `prompt` / `prompt-selection` 三种记录）。
只升级一侧时的表现都是「明确报错」，不会静默写坏数据：

- 旧客户端（v1）× 新服务端（v2）：客户端发现服务端版本更大，拒绝同步并提示升级页面
- 新客户端（v2）× 旧服务端（v1）：旧服务端不认新 kind，整批推送被判非法并回 400

老数据文件（只有 session / message）可以直接被 v2 服务端载入：未知/缺失的新 kind 只是 0 条。
