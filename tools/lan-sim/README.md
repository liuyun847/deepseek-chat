# 单机双端模拟 / 真机联调脚本

没有第二台手机时，用这三个脚本验证手机直连的四条链路（发现、配对、加密、合并）。它们**复用
`src/services/sync/lan/` 里同一份 TypeScript 源码**（编译产物在 `build/` 下，已被 gitignore），
所以验证的是协议与算法本身，不是另写一份实现。

| 文件 | 作用 | 需要什么 |
| --- | --- | --- |
| `run.mjs` | 拉起 3 个「设备」进程（A、B 同口令，C 不同口令），跑完整剧本并逐条断言 | 本机即可 |
| `peer.mjs` | 一台「设备」：UDP 广播发现 + TCP 请求/响应 + 加密信封 + 合并，可单独用 | 本机即可 |
| `interop.mjs` | 让宿主进程当「第二台手机」，向模拟器里的安卓端推一次真实同步 | 模拟器 + `adb forward` |

## 先编译一次

```powershell
npx tsc -p tools/lan-sim/tsconfig.json      # 产物在 tools/lan-sim/build/
```

脚本直接用 Node 24 跑 ESM，不需要 ts-node / tsx。

## 双进程模拟：发现 + 配对 + 加密 + 合并

```powershell
node tools/lan-sim/run.mjs
```

剧本（15 条断言，全部通过时退出码 0）：

1. 三个进程各自绑随机 TCP 端口，向 `255.255.255.255:47831` 广播自己的设备信息；
2. A 收到 B 的广播，口令指纹一致 → 判为已配对 → A（deviceId 较小）自动发起 hello/sync；
3. 两端会话互补（s1 两端都有、s2 只在 A、s3 只在 B），同一条会话两端都改过时按 LWW 收敛；
4. C 用不同口令，指纹不匹配 → 不同步；C 强行探活时 A 用 AES-GCM 校验失败拒收；
5. A 新增一条消息 → 自动推给 B；
6. A 删除会话 s2 → 墓碑同步过去，B 也删掉，且静置 4 秒不会被拉回来。

两个进程共享同一个 UDP 端口靠 `reuseAddr`：Windows 上广播包会投递给所有绑定该端口的 socket，
与真机上「大家都在同一个广播域」等价。

## 真机联调：宿主进程 → 模拟器里的安卓端

模拟器（雷电 9）的客户机只有 `172.16.1.0/24` 的链路路由，没有默认网关，因此**收不到宿主机的
单播、也连不回宿主机** —— 单模拟器上做不到「两端互相发现」。但反方向可以用 adb 打通：

```powershell
# 1. 先在 App 里开启手机直连并设好口令（口令必须与 --pass 一致）
# 2. 找到 App 当前监听的端口（设置 → 手机直连 → 本机 → 局域网地址 172.16.1.15:xxxxx）
adb forward tcp:47826 tcp:xxxxx
node tools/lan-sim/interop.mjs --port 47826 --pass <同一个口令>
```

成功的输出形如：

```text
本端 device=dev-zhost pairTag=32523f8035e1
hello 应答: device=dev-mwhuyliy stamp=741638a5a4ba stats={"records":0,"sessions":0,"messages":0}
sync 应答: 安卓端收到 4 条，落地 2 条，回给我 0 条
RESULT=PASS
```

这条链路覆盖「原生 accept → Bridge 回调 → 页面解密 → 合并 → 写 IndexedDB → 加密回包 → 另一方
解密校验」。App 端可以用「设置 → 手机直连 → 上次同步」和会话列表确认数据真的落库了。

## 协议要点（与 `android/java/ds/app/LanLink.java` 必须一致）

- 发现：UDP 端口 47823，广播 JSON `{format:"chat-demo-lan", proto:1, deviceId, name, port, pairTag}`；
- 传输：TCP，一问一答，帧 = 4 字节大端长度 + UTF-8 正文（不依赖半关，见 LanLink 注释）；
- 信封：`{format, proto, from, id, ts, iv, data}`，`data` 是 `gzip(AES-GCM(消息 JSON))` 的 base64；
- 消息：`hello`（比数据指纹）、`sync`（推记录）、`sync-reply`（回差异）、`ping`（催对方来拉）。
