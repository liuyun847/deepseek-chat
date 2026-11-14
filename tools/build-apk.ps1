#requires -Version 7
<#
.SYNOPSIS
    构建 APK。零 Gradle、零 Maven 依赖，链路为 aapt2 -> javac -> d8 -> jar -> zipalign -> apksigner。

.DESCRIPTION
    为什么不用 Gradle：本项目不引任何第三方库（含 AndroidX），需要的东西都在 Android SDK
    自身里。手工链路因此更短、更快，也彻底绕开国内网络拉 Maven 制品的失败点。

    前置：前端产物必须已经存在（脚本会检查 dist\index.html）
        pnpm --config.shell-emulator=true build

    步骤
      1. 暂存 assets：dist\* -> build\assets\*，再把 android\shell\shell.js 拷进去
      2. aapt2 compile：android\res\ -> *.flat
      3. aapt2 link：.flat + AndroidManifest + assets -> base.apk，同时产出 R.java
      3.5 修正 assets 条目名分隔符（Windows 上 aapt2 会写成反斜杠 -> 应用白屏）
      4. javac：MainActivity.java + R.java -> .class
      5. d8：.class -> classes.dex
      6. jar：把 classes.dex 塞进 base.apk
      7. zipalign：4 字节对齐（必须在签名之前）
      8. apksigner：v2 + v3 签名，私钥沿用 android\debug.keystore

    与旧版的差别：不再注入 API key。新版前端把 key 存在 localStorage（用户在设置里填），
    构建时没有任何密钥参与，assets 里也不该出现 sk- 开头的字符串（verify-apk.ps1 会查）。

.PARAMETER Dev
    跳过签名，输出未签名 APK（仅供 adb 调试，装不上）。

.PARAMETER RegenerateKey
    debug.keystore 丢失时重建一份新的私钥。注意：新私钥签出来的 APK 与已装应用签名不同，
    必须先卸载旧应用才能安装，本地聊天记录（IndexedDB）会一起丢掉 —— 所以默认不自动重建。

.EXAMPLE
    pnpm --config.shell-emulator=true build
    .\tools\build-apk.ps1
    .\tools\verify-apk.ps1
#>

param(
    [switch]$Dev,
    [switch]$RegenerateKey
)

$ErrorActionPreference = 'Stop'

# 本文件是 UTF-8 with BOM（含中文，Windows PowerShell 5.1 也认）。改动后必须保持 BOM。

# ── 定位工具链 ──────────────────────────────────────────────────────────────
$Root   = Split-Path -Parent $PSScriptRoot
$Jdk    = Join-Path $env:USERPROFILE '.devtools\jdk17'
$Sdk    = Join-Path $env:USERPROFILE '.devtools\android-sdk'
$BtVer  = '35.0.1'
$Bt     = Join-Path $Sdk "build-tools\$BtVer"
$Pf     = Join-Path $Sdk 'platforms\android-35'
$Jar    = Join-Path $Pf 'android.jar'
$Front  = Join-Path $Root 'dist'
$Build  = Join-Path $Root 'build'
$OutDir = Join-Path $Root 'dist-apk'

foreach ($f in @(
    (Join-Path $Jdk 'bin\javac.exe'), (Join-Path $Jdk 'bin\keytool.exe'), (Join-Path $Jdk 'bin\jar.exe'),
    (Join-Path $Bt 'aapt2.exe'), (Join-Path $Bt 'd8.bat'),
    (Join-Path $Bt 'zipalign.exe'), (Join-Path $Bt 'apksigner.bat'), $Jar)) {
    if (-not (Test-Path $f)) {
        throw ("缺少工具：" + $f + [Environment]::NewLine + '请先运行 tools\setup-toolchain.ps1')
    }
}
$env:JAVA_HOME = $Jdk
$env:PATH = "$Jdk\bin;$env:PATH"

if (-not (Test-Path (Join-Path $Front 'index.html'))) {
    throw ("缺少前端产物：" + (Join-Path $Front 'index.html') + [Environment]::NewLine + '先运行：pnpm --config.shell-emulator=true build')
}

# 版本号：versionName 取 package.json，versionCode 按 semver 折算成 major*10000+minor*100+patch。
# 折算而不是写死 1，是为了让后续每次发版的 versionCode 单调递增 —— Android 只靠它判断"能不能覆盖升级"，
# 相同 versionCode 可以覆盖安装，比已装的低会被 INSTALL_FAILED_VERSION_DOWNGRADE 拒掉。
$pkgPath = Join-Path $Root 'package.json'
$verName = (Get-Content -Raw -LiteralPath $pkgPath | ConvertFrom-Json).version
if ($verName -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "package.json 的 version 不是 x.y.z 形式：$verName" }
$verCode = [int]$Matches[1] * 10000 + [int]$Matches[2] * 100 + [int]$Matches[3]

# 每次构建前清干净中间产物与输出目录。
# 注意：不碰 dist\ —— 那是前端产物，删掉就得重新 pnpm build。
foreach ($d in @($Build, $OutDir)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

function Step($n, $msg) { Write-Host ''; Write-Host "[$n] $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }

# ── 1. 暂存 assets ──────────────────────────────────────────────────────────
Step 1 '暂存前端资源'
$assets = Join-Path $Build 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
# 不用 -Path 'dist\*' 通配符：目标目录不存在时 PowerShell 7.6 会报
# "无法将容器复制到现有叶项上"。逐项枚举 + -LiteralPath 最稳，也顺带避开文件名里的通配符。
Get-ChildItem -LiteralPath $Front -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $assets -Recurse -Force
}
# 壳层补丁脚本：由 MainActivity 在 onPageFinished 时读取，不被 index.html 引用
Copy-Item -LiteralPath (Join-Path $Root 'android\shell\shell.js') -Destination (Join-Path $assets 'shell.js') -Force
$assetFiles = @(Get-ChildItem $assets -Recurse -File)
$mb = [math]::Round((($assetFiles | Measure-Object Length -Sum).Sum) / 1MB, 2)
Ok ("assets 就绪，共 {0} MB / {1} 个文件" -f $mb, $assetFiles.Count)

# ── 2. aapt2 compile ────────────────────────────────────────────────────────
Step 2 '编译资源 (aapt2 compile)'
$flat = Join-Path $Build 'flat'
New-Item -ItemType Directory -Force -Path $flat | Out-Null
& (Join-Path $Bt 'aapt2.exe') compile --dir (Join-Path $Root 'android\res') -o $flat
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }
$flats = @(Get-ChildItem $flat -Filter *.flat | ForEach-Object { $_.FullName })
Ok "$($flats.Count) 个资源文件已编译"

# ── 3. aapt2 link ───────────────────────────────────────────────────────────
Step 3 '链接资源与清单 (aapt2 link)'
$baseApk = Join-Path $Build 'base.apk'
$rJava   = Join-Path $Build 'rjava'
New-Item -ItemType Directory -Force -Path $rJava | Out-Null
$linkArgs = @(
    '-I', $Jar,
    '--manifest', (Join-Path $Root 'android\AndroidManifest.xml'),
    '-A', $assets,
    '--java', $rJava,
    '--min-sdk-version', '26',
    '--target-sdk-version', '34',
    '--version-code', "$verCode",
    '--version-name', "$verName",
    '-o', $baseApk
) + $flats
& (Join-Path $Bt 'aapt2.exe') link @linkArgs
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }
Ok "base.apk $([math]::Round((Get-Item $baseApk).Length/1MB,2)) MB，R.java 已生成（版本 $verName / $verCode）"

# aapt2 在 Windows 上会把 assets 条目名写成 assets\static\js\main.js（反斜杠），
# 而 Android 要求正斜杠，否则 AssetManager.open("static/js/main.js") 找不到 -> 白屏。
# 这里只改文件名不动数据，保证 resources.arsc 仍是未压缩且对齐的。
Write-Host ''
Write-Host '[3.5] 修正 assets 路径分隔符' -ForegroundColor Yellow
& node (Join-Path $PSScriptRoot 'fix-apk-paths.mjs') $baseApk
if ($LASTEXITCODE -ne 0) { throw '修正 APK 路径失败' }

# ── 4. javac ────────────────────────────────────────────────────────────────
Step 4 '编译 Java (javac)'
$classes = Join-Path $Build 'classes'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$sources = @((Join-Path $Root 'android\java\ds\app\MainActivity.java')) +
    @(Get-ChildItem $rJava -Recurse -Filter *.java | ForEach-Object { $_.FullName })
# -source 8：android.jar 里没有 LambdaMetafactory，MainActivity 全用匿名内部类，不能用 lambda
$javacArgs = @(
    '-encoding', 'UTF-8', '-source', '8', '-target', '8',
    '-bootclasspath', $Jar, '-classpath', $Jar, '-Xlint:-options',
    '-d', $classes
) + $sources
& (Join-Path $Jdk 'bin\javac.exe') @javacArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }
Ok "$((Get-ChildItem $classes -Recurse -Filter *.class).Count) 个 class"

# ── 5. d8 ───────────────────────────────────────────────────────────────────
Step 5 '转换为 dex (d8)'
$dex = Join-Path $Build 'dex'
New-Item -ItemType Directory -Force -Path $dex | Out-Null
Push-Location $classes
try {
    & (Join-Path $Bt 'd8.bat') --lib $Jar --min-api 26 --output $dex (Get-ChildItem -Recurse -Filter *.class | ForEach-Object { $_.FullName })
    if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }
} finally { Pop-Location }
Ok "classes.dex $([math]::Round((Get-Item (Join-Path $dex 'classes.dex')).Length/1KB,1)) KB"

# ── 6. 把 dex 塞进 APK ──────────────────────────────────────────────────────
Step 6 '打包 classes.dex'
& (Join-Path $Jdk 'bin\jar.exe') uf $baseApk -C $dex classes.dex
if ($LASTEXITCODE -ne 0) { throw 'jar 打包 dex 失败' }
Ok '已注入'

# ── 7. zipalign（必须在签名之前）────────────────────────────────────────────
Step 7 '对齐 (zipalign)'
$aligned = Join-Path $Build 'aligned.apk'
& (Join-Path $Bt 'zipalign.exe') -f -p 4 $baseApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }
Ok '4 字节对齐完成'

# ── 8. 签名 ─────────────────────────────────────────────────────────────────
if ($Dev) {
    $final = Join-Path $OutDir 'app-unsigned.apk'
    Copy-Item $aligned $final
    Write-Host ''
    Write-Host '[跳过] 未签名模式' -ForegroundColor Yellow
} else {
    Step 8 '签名 (apksigner)'
    $ks = Join-Path $Root 'android\debug.keystore'
    if (-not (Test-Path $ks)) {
        if (-not $RegenerateKey) {
            $hint = @(
                "缺少签名私钥：$ks",
                '',
                '覆盖升级已装的应用必须用同一份私钥，所以脚本不会默默生成新的。',
                '从旧项目/备份里把 debug.keystore 拷回 android\ 即可（2726 字节那份）。',
                '确实没有、并且能接受"先卸载旧应用（本地记录全丢）"时，用：',
                '    .\tools\build-apk.ps1 -RegenerateKey'
            ) -join [Environment]::NewLine
            throw $hint
        }
        Write-Host '    重建签名私钥（旧应用的覆盖升级会失败，需先卸载）…' -ForegroundColor DarkYellow
        $keyArgs = @(
            '-genkeypair', '-v',
            '-keystore', $ks, '-storepass', 'android', '-keypass', 'android',
            '-alias', 'dsapp', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
            '-dname', 'CN=DeepSeek Chat, OU=Personal, O=Personal, L=-, ST=-, C=CN'
        )
        & (Join-Path $Jdk 'bin\keytool.exe') @keyArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '生成 keystore 失败' }
        Ok "已生成 $ks"
    }
    $final = Join-Path $OutDir 'deepseek-chat.apk'
    $signArgs = @(
        'sign',
        '--ks', $ks, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
        '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
        '--out', $final, $aligned
    )
    & (Join-Path $Bt 'apksigner.bat') @signArgs
    if ($LASTEXITCODE -ne 0) { throw 'apksigner 失败' }
    # 不启用 v1（JAR 签名）：minSdk 26 起 v2 已足够，且 v1 是更弱的方案
    Ok 'v2 + v3 签名完成（v1 跳过：minSdk 26 起 v2 已足够）'
}

# ── 校验 ────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '构建产物' -ForegroundColor Cyan
Write-Host "  $final  ($([math]::Round((Get-Item $final).Length/1MB,2)) MB)"
if (-not $Dev) {
    & (Join-Path $Bt 'apksigner.bat') verify --print-certs $final 2>&1 |
        Select-String 'Verified using|Signer #1 certificate DN' | ForEach-Object { Write-Host "  $($_.Line.Trim())" -ForegroundColor DarkGray }
    Write-Host ''
    Write-Host '下一步：.\tools\verify-apk.ps1' -ForegroundColor Cyan
    Write-Host ("安装：adb install -r " + $final) -ForegroundColor Cyan
}
