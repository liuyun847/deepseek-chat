# android/libs —— 第三方二进制（唯一一处）

本项目**原则上不引任何第三方库**（含 AndroidX、不含 Gradle/Maven 解析，见 tools/build-apk.ps1 文件头）。
这里放的是唯一的例外：ZXing core 3.5.3，只用来把相机帧/图片解成二维码字符串。

| 文件 | 是什么 |
| --- | --- |
| `zxing-core-3.5.3.jar` | 上游原包，未裁剪、未改字节 |
| `LICENSE-APACHE-2.0.txt` | Apache-2.0 许可全文（jar 里**没有**许可文件，只有 META-INF/MANIFEST.MF 与 pom；Apache-2.0 第 4 条要求随分发附带，所以单独放一份） |

## 来源与校验

| 项 | 值 |
| --- | --- |
| 上游 | `https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar` |
| 大小 | 607,650 字节（593.4 KB），332 条目 / 291 个 class |
| SHA-256 | `8D8064C1636FDAEF7189DD9055C7D59950A8940A12F2293956446EC3C109FD82` |
| 许可 | Apache-2.0（jar 的 MANIFEST 里 `Bundle-License: "The Apache Software License, Version 2.0"`） |
| class 版本 | 全部 major 52（Java 8），与本项目 `-source 8` 兼容 |
| 桌面 API 引用 | 0 处（java/awt、javax/imageio、javax/swing、sun/、javax/xml、java/time 全都没有） |
| 维护状态 | 3.5.3 是当前最新版（2023-11），纯 Java、无传递依赖 |

重新下载后请先核对 sha256：

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath android\libs\zxing-core-3.5.3.jar).Hash
# 必须是 8D8064C1636FDAEF7189DD9055C7D59950A8940A12F2293956446EC3C109FD82
```

## 为什么是 plain jar，不是 AAR

AAR 需要 Gradle/AGP 做资源合并与 manifest 合并，而本项目的构建链是手工的
（aapt2 → javac → d8 → jar → zipalign → apksigner，零 Gradle）。ZXing 的 `core` 制品正好是
**只含 class 的 plain jar**：没有 res、没有 AndroidManifest、没有传递依赖 —— 只需要在
`tools/build-apk.ps1` 的两处把它带上（javac 的 `-classpath`、d8 的 program 输入）。
ZXing 的 `android-embedded` 才是 AAR，本目录**不要**换成它。

## 构建链怎么用它

```powershell
pnpm --config.shell-emulator=true build   # 前端产物
.\tools\build-apk.ps1                     # javac 的 classpath 与 d8 的输入都会自动带上本目录的 *.jar
.\tools\verify-apk.ps1
```

体积代价（本机实测）：

| 输入 | classes.dex | APK 内压缩后 |
| --- | --- | --- |
| 不加 jar（现状） | 42.1 KB | 20.9 KB |
| 加整包 jar | 约 570 KB（+528 KB） | 见 `.dsh\.project\deepseek-chat-本地服务\QR-PAIRING-M123.md` 的实测 |

**jar 本身不会进 APK**：只有 classes.dex 会被加载。所以 d8 必须把 jar 一起转 dex，
否则运行期表现为 `NoClassDefFoundError: com.google.zxing...`。

## 想换成子集（只含 QR 解码需要的类）

整包把 DataMatrix/PDF417/Aztec 等全部四种码和 writer 也编译进去了。只做 QR 扫描的话
可以把 jar 裁到 `com/google/zxing/*.class` + `qrcode/**` + `common/**`（94 个 class，
约 158 KB，dex 约 161 KB），但**必须**同时补一个可复现的生成脚本 + 上游 sha256 校验，
否则半年后没人说得清这份 jar 是怎么来的。裁剪后的闭包要拿桌面 JVM 的解码探针复验一次
（能解出完整配对串才算过）。当前**没有**做裁剪：先把手感与识别率跑通，裁剪留到需要时。

## 许可怎么随分发

- APK 分发（应用市场 / 网盘 / 直接发 apk）时，`LICENSE-APACHE-2.0.txt` 必须一并提供；
  仓库里它就在本目录，`dist/` 的 LICENSE 是主体项目的 MIT，与这里不是一回事。
- 不要修改 jar 内容（改了就变成你自己的再分发，Apache-2.0 第 4(b) 条要求标注修改）。
- 上游版权声明在 jar 的 `META-INF/MANIFEST.MF` 与各 .class 文件头里，原样保留。
