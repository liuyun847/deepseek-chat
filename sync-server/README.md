# sync-server（多端同步服务，M1）

零依赖的本地同步服务：只用 Node.js 内置模块（`node:http` / `node:fs` / `node:path`）。
数据存成一个 JSON 文件，客户端通过 HTTP 拉全量、推变更。

## 启动

```sh
# 默认：127.0.0.1:7788，数据写 sync-server/data/sync-data.json
node sync-server/server.mjs

# 指定端口 / 数据文件 / 局域网监听
node sync-server/server.mjs --port 7788 --data D:\sync\chat.json --host 0.0.0.0
```

| 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--port` | `SYNC_PORT` | `7788` | 监听端口 |
| `--host` | `SYNC_HOST` | `127.0.0.1` | 监听地址；局域网内其它设备要连时用 `0.0.0.0` |
| `--data` | `SYNC_DATA` | `sync-server/data/sync-data.json` | 数据文件（相对路径按当前工作目录解析） |
| `--name` | `SYNC_NAME` | 主机名 | 在 `/api/health` 里自报的名字 |

启动后终端会打印端口与数据文件路径；`Ctrl+C` 会先落盘再退出。

## 接口

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok, format, version, name, time, dataFile, records, sessions, messages, tombstones }` |
| GET | `/api/state` | — | `{ ok, format, version, time, records: SyncRecord[] }`（全量，含墓碑） |
| POST | `/api/sync` | `{ device, records }` | `{ ok, applied: { accepted, rejected }, collapsed, records: SyncRecord[] }`（合并后的全量） |
| GET | `/` | — | 自报身份与端点清单 |

`OPTIONS` 返回 204 + CORS 头，允许 `GET` / `POST` / `Content-Type`，回显 `Origin`（客户端跑在 dev server 8090 或别的端口上）。
单次请求体上限 32 MB。

诊断命令：

```sh
curl http://127.0.0.1:7788/api/health
curl http://127.0.0.1:7788/api/state
```

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

- `kind`：`session`（会话级元数据，不含 messages）或 `message`（完整消息对象，字段原样搬运）
- 主键是 `kind + ":" + id`
- `deletedAt` 非空即墓碑，此时 `data` 为 `null`
- `device` 只用于 `updatedAt` 撞车时的 tie-break

## 合并规则

1. `updatedAt` 大者胜；相同则 `device` 字符串大者胜（两端算出的赢家一致，不会永久分叉）
2. 会话已删除时，它名下的消息一律墓碑化；墓碑字段只由会话墓碑推导，保证各端结果一致
3. 服务端与客户端必须是同一套规则：本文件 `compareRecords` / `collapseDeletedSessions` 与
   `src/services/sync/merge.ts` 逐条对应，改一侧要同步改另一侧

## 限制（M1）

- 没有鉴权：局域网内能访问该端口的人都能读到全部会话内容。只建议在同一台机器或可信局域网使用；
  M2 若要跨不可信网络，需要口令或走隧道。
- 不清理墓碑（删除记录会一直留着，用于防止复活）；量大了需要手工清理数据文件。
- 只同步会话与消息的文本/结构，不同步附件原件（图片等）。
- 单进程、单文件：并发写入靠 Node 单线程串行，够个人多端使用，不是多实例集群方案。

## 数据文件

```json
{ "format": "chat-demo-sync", "version": 1, "updatedAt": 0, "records": { "session:<id>": { ... } } }
```

写入是先写 `*.tmp` 再 rename 的原子替换；进程被强杀最多丢掉最后一次尚未落盘的写入（去抖 200ms）。
