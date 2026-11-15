#requires -Version 7
<#
.SYNOPSIS
    校验构建出的 APK 是否符合预期（不装设备也能查的项）。

.DESCRIPTION
    检查项都是"出问题就会白屏或装不上"的那种硬约束：
      1. assets 条目名必须是正斜杠（aapt2 在 Windows 上会写成反斜杠 -> WebView 白屏）
      2. assets 里必须有 dist 的入口与静态资源；内置 key（本地有密钥文件时）必须与之指纹一致
      3. resources.arsc 必须未压缩且 4 字节对齐（targetSdk 30+ 的硬要求）
      4. 签名方案有效（v2 / v3）
      5. manifest 的包名 / 版本 / minSdk / targetSdk / 权限 / 启动 Activity 正确
      6. networkSecurityConfig 在位且只信任系统 CA（局域网同步依赖明文放行）

.EXAMPLE
    .\tools\verify-apk.ps1
    .\tools\verify-apk.ps1 -Apk dist-apk\deepseek-chat.apk
#>

param(
    [string]$Apk = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist-apk\deepseek-chat.apk')
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 本文件是 UTF-8 with BOM（含中文，Windows PowerShell 5.1 也认）。改动后必须保持 BOM。

$Root = Split-Path -Parent $PSScriptRoot
$Bt = Join-Path $env:USERPROFILE '.devtools\android-sdk\build-tools\35.0.1'
$env:JAVA_HOME = Join-Path $env:USERPROFILE '.devtools\jdk17'
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path $Apk)) {
    throw ('APK 不存在：' + $Apk + [Environment]::NewLine + '先运行 .\tools\build-apk.ps1')
}

$pass = 0; $fail = 0
function Ok($msg)  { $script:pass++; Write-Host "  [OK] $msg" -ForegroundColor Green }
function Bad($msg) { $script:fail++; Write-Host "  [!!] $msg" -ForegroundColor Red }
function Test-Ok($cond, $msg) { if ($cond) { Ok $msg } else { Bad $msg } }

Write-Host ''
Write-Host "校验 $Apk（$([math]::Round((Get-Item $Apk).Length/1MB,2)) MB）" -ForegroundColor Cyan

# 期望版本取自 package.json，与 build-apk.ps1 用同一套折算规则
$verName = (Get-Content -Raw -LiteralPath (Join-Path $Root 'package.json') | ConvertFrom-Json).version
if ($verName -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "package.json 的 version 不是 x.y.z 形式：$verName" }
$verCode = [int]$Matches[1] * 10000 + [int]$Matches[2] * 100 + [int]$Matches[3]

# ── 1. assets 结构与路径分隔符 ──────────────────────────────────────────────
Write-Host ''
Write-Host '【assets 路径与内容】' -ForegroundColor Yellow
$zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
$entries = @($zip.Entries | ForEach-Object { $_.FullName })
$backslash = @($entries | Where-Object { $_ -match '\\' })
Test-Ok ($backslash.Count -eq 0) "无反斜杠条目（发现 $($backslash.Count) 个）"
if ($backslash.Count) { $backslash | Select-Object -First 5 | ForEach-Object { Write-Host "      $_" -ForegroundColor Red } }

$assets = @($entries | Where-Object { $_ -like 'assets/*' })
Test-Ok ($assets.Count -gt 0) "assets 条目存在（$($assets.Count) 个）"
Test-Ok ($entries -contains 'assets/index.html') '入口 assets/index.html 就位'
$mainJs = @($entries | Where-Object { $_ -match '^assets/static/js/main\.[0-9a-f]{8}\.js$' })
Test-Ok ($mainJs.Count -eq 1) "主脚本就位（$($mainJs -join ', ')）"
$mainCss = @($entries | Where-Object { $_ -match '^assets/static/css/main\.[0-9a-f]{8}\.css$' })
Test-Ok ($mainCss.Count -eq 1) "主样式就位（$($mainCss -join ', ')）"
$asyncJs = @($entries | Where-Object { $_ -match '^assets/static/js/async/[0-9]+\.' })
Test-Ok ($asyncJs.Count -gt 0) "异步 chunk 已打进包（$($asyncJs.Count) 个）"
$fonts = @($entries | Where-Object { $_ -match '^assets/static/media/.+\.(woff2?|ttf)$' })
Test-Ok ($fonts.Count -gt 0) "字体资源已打进包（$($fonts.Count) 个）"
Test-Ok ($entries -contains 'assets/shell.js') '壳层补丁 assets/shell.js 就位'

# 入口 html 里必须真的引用到主脚本与主样式，否则包内是一份断链的页面
$htmlEntry = $zip.Entries | Where-Object { $_.FullName -eq 'assets/index.html' }
$reader = New-Object System.IO.StreamReader($htmlEntry.Open())
$html = $reader.ReadToEnd()
$reader.Close()
Test-Ok ($html -match 'static/js/main\.[0-9a-f]{8}\.js') 'index.html 引用了主脚本'
Test-Ok ($html -match 'static/css/main\.[0-9a-f]{8}\.css') 'index.html 引用了主样式'

# ── 2. 密钥 ─────────────────────────────────────────────────────────────────
# key 由 rspack 在构建期从 .secrets\api-key.txt 注入主包（见 rspack.config.ts），
# 所以「包内有 sk- 串」本身是预期的；要查的是它必须与本地密钥文件一致 —— 不一致说明
# dist 是旧产物（没带 key）或打进了不相干的 key。没有密钥文件时仍要求零命中。
Write-Host ''
Write-Host '【密钥】' -ForegroundColor Yellow
$SecretPath = Join-Path $Root '.secrets\api-key.txt'
$SecretKey = $null
if (Test-Path -LiteralPath $SecretPath) {
    $SecretKey = (Get-Content -Raw -LiteralPath $SecretPath).Trim()
}
$skFiles = @()
$keyFiles = @{}
foreach ($e in $zip.Entries) {
    if ($e.FullName -notlike 'assets/*') { continue }
    if ($e.FullName -notmatch '\.(js|css|html|json|txt|map)$') { continue }
    $r = New-Object System.IO.StreamReader($e.Open())
    $t = $r.ReadToEnd()
    $r.Close()
    if ($t -match 'sk-[A-Za-z0-9]{20,}') { $skFiles += $e.FullName }
    if ($SecretKey -and $t.Contains($SecretKey)) { $keyFiles[$e.FullName] = $true }
}
if ($SecretKey) {
    # 指纹只含前 4 位，日志里不出现完整 key
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $digest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($SecretKey))).Replace('-', '').ToLower()
    $sha.Dispose()
    $fp = ('{0}…，长度 {1}，sha256 {2}' -f $SecretKey.Substring(0, 4), $SecretKey.Length, $digest.Substring(0, 8))
    Test-Ok ($keyFiles.Count -ge 1) "内置 API key 与本地密钥文件一致（$($keyFiles.Count) 个 assets 文件，指纹 $fp）"
    $unexpected = @($skFiles | Where-Object { -not $keyFiles.ContainsKey($_) })
    Test-Ok ($unexpected.Count -eq 0) "assets 里没有其它来历不明的明文 key（命中 $($unexpected.Count) 个文件）"
    if ($unexpected.Count) { $unexpected | Select-Object -First 5 | ForEach-Object { Write-Host "      $_" -ForegroundColor Red } }
} else {
    Test-Ok ($skFiles.Count -eq 0) "无本地密钥文件时 assets 内无明文 API key（命中 $($skFiles.Count) 个文件）"
    if ($skFiles.Count) { $skFiles | Select-Object -First 5 | ForEach-Object { Write-Host "      $_" -ForegroundColor Red } }
}

$shellEntry = $zip.Entries | Where-Object { $_.FullName -eq 'assets/shell.js' }
if ($shellEntry) {
    $r = New-Object System.IO.StreamReader($shellEntry.Open())
    $shellText = $r.ReadToEnd()
    $r.Close()
    Test-Ok ($shellText -match '__dsBack') 'shell.js 含返回键补丁'
    Test-Ok ($shellText -match 'saveBase64') 'shell.js 含导出下载补丁'
}
$zip.Dispose()

# ── 3. 资源表必须未压缩且对齐 ───────────────────────────────────────────────
Write-Host ''
Write-Host '【资源表与对齐】' -ForegroundColor Yellow
$align = & (Join-Path $Bt 'zipalign.exe') -c -v 4 $Apk 2>&1
$arscLine = ($align | Select-String 'resources\.arsc') -join ''
Test-Ok ($arscLine -match '\(OK\s*$' -or $arscLine -match '\(OK\)') ('resources.arsc 未压缩且已对齐 ' + $arscLine.Trim())
$dexLine = ($align | Select-String 'classes\.dex') -join ''
Test-Ok ($dexLine -match 'OK') 'classes.dex 校验通过'
$alignBad = @($align | Where-Object { $_ -match 'BAD' })
Test-Ok ($alignBad.Count -eq 0) "无未对齐条目（发现 $($alignBad.Count) 个）"

# ── 4. 签名 ─────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '【签名】' -ForegroundColor Yellow
$ver = (& (Join-Path $Bt 'apksigner.bat') verify -v --print-certs $Apk 2>&1) -join [Environment]::NewLine
Test-Ok ($ver -match '\bVerifies\b') '签名校验通过'
$v2 = $ver -match 'v2 scheme.*:\s*true'
$v3 = $ver -match 'v3 scheme.*:\s*true'
Test-Ok ($v2 -or $v3) "使用 v2/v3 方案（v2=$v2 v3=$v3，minSdk 26 起 v2 已足够）"
$dn = ([regex]::Match($ver, 'Signer #1 certificate DN:\s*(.+)')).Groups[1].Value.Trim()
Test-Ok ($dn -match 'CN=DeepSeek Chat') "签名证书 DN 与旧版一致（$dn）"

# ── 5. manifest ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '【清单】' -ForegroundColor Yellow
$badging = (& (Join-Path $Bt 'aapt2.exe') dump badging $Apk 2>&1) -join [Environment]::NewLine
Test-Ok ($badging -match "package: name='ds\.app'") '包名 ds.app（沿用旧版，可覆盖升级）'
Test-Ok ($badging -match "versionCode='$verCode'") "versionCode = $verCode"
Test-Ok ($badging -match ("versionName='" + [regex]::Escape($verName) + "'")) "versionName = $verName"
Test-Ok ($badging -match "sdkVersion:'26'") 'minSdk 26'
Test-Ok ($badging -match "targetSdkVersion:'34'") 'targetSdk 34'
Test-Ok ($badging -match 'android\.permission\.INTERNET') '已声明 INTERNET 权限'
$permCount = ([regex]::Matches($badging, 'uses-permission:')).Count
Test-Ok ($permCount -eq 1) "只声明 1 条权限（实际 $permCount 条）"
Test-Ok ($badging -match 'launchable-activity.*ds\.app\.MainActivity') '启动 Activity 就位'

# ── 6. 网络安全配置（局域网同步依赖它）────────────────────────────────────
Write-Host ''
Write-Host '【网络安全配置】' -ForegroundColor Yellow
$xmltree = (& (Join-Path $Bt 'aapt2.exe') dump xmltree $Apk --file AndroidManifest.xml 2>&1) -join [Environment]::NewLine
Test-Ok ($xmltree -match 'networkSecurityConfig') 'manifest 引用了 networkSecurityConfig'
# 与配置文件并存时 API 24+ 以配置文件为准。留着 usesCleartextTraffic 只会让读代码的人
# 以为明文还禁着 —— 两处设置打架是这类 bug 最常见的来源
Test-Ok ($xmltree -notmatch 'usesCleartextTraffic') 'usesCleartextTraffic 已移除（不与配置文件互相误导）'

$nsc = (& (Join-Path $Bt 'aapt2.exe') dump xmltree $Apk --file res/xml/network_security_config.xml 2>&1) -join [Environment]::NewLine
Test-Ok ($nsc -match 'cleartextTrafficPermitted=true') 'cleartextTrafficPermitted=true（局域网 http 才通）'
Test-Ok ($nsc -match 'src="system"') '信任锚只有系统 CA（https 没有被放宽）'
Test-Ok ($nsc -notmatch 'src="user"|src="debug') '没有引入用户/调试 CA'

Write-Host ''
Write-Host ('-' * 46)
if ($fail -eq 0) { Write-Host "全部通过（$pass 项）" -ForegroundColor Green }
else { Write-Host "通过 $pass　失败 $fail" -ForegroundColor Red; exit 1 }
