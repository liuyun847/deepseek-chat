# 二维码解码样本（L3 解码自检的输入）

这里放 **4 张固定的二维码图片**，给 `tools\qr-decode-check.ps1` 当基准。
每张都钉住一种解析结果，少一张就少一类回归保护：

| 文件 | 内容 | 期望 |
| --- | --- | --- |
| `pair-https.png` | 本项目的配对串（HTTPS + 证书指纹 + `x` 未过期，v8 / 49 模块 / 456 px） | 解出的串与 `expected.json` 里的 `uri` 逐字符相同；解析出 `host=192.168.124.10:7788`、`code=ABCD2345`、`expired=false` |
| `pair-http-loopback.png` | 明文 HTTP + 回环 + 无指纹（v4 / 33 模块） | 同样逐字符相同；解析出 `host=127.0.0.1:7788`、无指纹 |
| `pair-expired.png` | `x` 是 2020-09 的时间戳 | 解析仍 `ok`，但 `expired=true`（过期由服务端判，解析器只提示） |
| `not-a-pair.png` | 一张正常的二维码，但内容是 `https://example.com/…` | 解码成功（必须解得出原文），解析按 `reason=scheme` 拒绝 |

`x` 的时间戳刻意选「2100 年」与「2020 年」两个极端：前者保证样本**永远**是「未过期」，
后者**永远**过期 —— 否则跑几年之后这类断言会自己变红。

## 怎么重新生成

样本不是手画的，也不该手改：

```powershell
node tools/qr-samples/generate.mjs
```

它用**页面里同一个编码器**（`src/services/sync/pairing.ts` 的 `pairQrMatrix()`，
经 `tools/pair-sim/tsconfig.json` 编成 JS 后 import；源码比产物新时会自动重编），
把矩阵写成灰度 PNG（8 px/模块、4 模块静区，PNG 编码在脚本里手写：zlib + CRC-32）。
同时刷新 `expected.json`（`qr-decode-check.ps1` 读的就是它）。

换串/换编码器/改纠错级别会让图片变，这**正是**这个脚本存在的意义：样本与生成方式一起进仓库，
半年后谁都能说清某张图是怎么来的。

## 临时生成一张（不进仓库）

```powershell
node tools/qr-samples/generate.mjs --uri "deepseek-sync://pair?..." --out "$env:TEMP\one.png"
```

调试真机/模拟器时用它把「当前服务端刚生成的那条串」变成一张图（`adb push` 到
`/sdcard/Download/` 后在扫码界面点「从图片选择」）。
