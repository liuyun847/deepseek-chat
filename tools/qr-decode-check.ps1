<#
  qr-decode-check.ps1 — 二维码解码自检（L3）：固定样本 → 解出原文 → 与预期逐字符比对

  为什么要有它
    「扫码」这条路在没真机时只能验一半：相机打不开，但**解码**这一段是可以完整验证的。
    被验的不是第二套实现：这个脚本编译的就是 android\java\ds\app\QrDecode.java ——
    APK 里 ScanActivity 调用的同一份文件，没有任何 android.* 引用，所以能在桌面 JVM 上跑。

  两种模式都跑（对应 ScanActivity 的两条输入路径）
    RGB：图片 → ARGB 像素 → QrDecode.decodeRgb       （「从图片选择」走这条）
    YUV：图片 → Y 平面 + 行填充 → QrDecode.decodeY   （相机帧走这条，rowStride 常大于宽度）

  YUV 模式是重点：行跨距写错时图像会「每行右移一点」，人眼几乎看不出但解码器永远 NotFound。
  探针故意把填充字节写成 0x5A，漏读跨距就会立刻解不出来。

  用法
    .\tools\qr-decode-check.ps1             # 编译 + 跑全部样本（两种模式）
    .\tools\qr-decode-check.ps1 -NoBuild    # 复用上次编译结果
    .\tools\qr-decode-check.ps1 -SamplesOnly pair-https.png   # 只跑一个样本

  退出码：0 = 全部通过；1 = 有失败项（会指出是哪张、哪种模式、差在哪）
  依赖：JDK 17（%USERPROFILE%\.devtools\jdk17，与 build-apk.ps1 同一个）、
        android\libs\zxing-core-3.5.3.jar、node（可选：把解出的串再过一遍解析器）
  编码：本文件是 UTF-8 with BOM（含中文，Windows PowerShell 5.1 读无 BOM 会按 cp936 解码）
#>

[CmdletBinding()]
param(
    # 跳过 javac，直接用上次的 classes（改了解码代码就必须重编）
    [switch]$NoBuild,

    # 只跑指定样本（文件名，可多个）
    [string[]]$SamplesOnly = @()
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Jdk = Join-Path $env:USERPROFILE '.devtools\jdk17'
$Java = Join-Path $Jdk 'bin\java.exe'
$Javac = Join-Path $Jdk 'bin\javac.exe'
$Libs = Join-Path $Root 'android\libs'
$Zxing = @(Get-ChildItem -LiteralPath $Libs -Filter 'zxing-core-*.jar' -File -ErrorAction SilentlyContinue)
$DecodeSrc = Join-Path $Root 'android\java\ds\app\QrDecode.java'
$CliSrc = Join-Path $PSScriptRoot 'qr-decode\QrDecodeCli.java'
$Samples = Join-Path $PSScriptRoot 'qr-samples'
$Expected = Join-Path $Samples 'expected.json'
$Out = Join-Path $PSScriptRoot 'qr-decode\build'
$NL = [Environment]::NewLine

$pass = 0
$fail = 0

function Test-Ok {
    param([bool]$Condition, [string]$Message)
    if ($Condition) {
        Write-Host "  [OK] $Message" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  [FAIL] $Message" -ForegroundColor Red
        $script:fail++
    }
}

function Write-Step {
    param([string]$Title)
    Write-Host ''
    Write-Host "【$Title】" -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $Java)) {
    Write-Host "缺少 JDK：$Java（先跑 tools\setup-toolchain.ps1）" -ForegroundColor Red
    exit 1
}
if ($Zxing.Count -eq 0) {
    Write-Host "缺少 ZXing jar：$Libs 下的 zxing-core-*.jar" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $Expected)) {
    Write-Host "缺少样本清单：$Expected（先跑 node tools/qr-samples/generate.mjs）" -ForegroundColor Red
    exit 1
}
$ZxingJar = $Zxing[0].FullName

$cases = @(Get-Content -Raw -LiteralPath $Expected | ConvertFrom-Json)
if ($SamplesOnly.Count -gt 0) {
    $cases = @($cases | Where-Object { $SamplesOnly -contains $_.file })
}
if ($cases.Count -eq 0) {
    Write-Host '没有要跑的样本（-SamplesOnly 没匹配上？）' -ForegroundColor Red
    exit 1
}

# ── 编译 ────────────────────────────────────────────────────────────────────
Write-Step '编译解码代码（APK 里同一份 QrDecode.java）'
$classes = Join-Path $Out 'classes'
if (-not $NoBuild) {
    if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $classes | Out-Null
    # -source 8 -target 8：与 tools\build-apk.ps1 的 javac 参数一致，
    # 等于顺手钉住「这份代码仍然只用 Java 8 语法」—— 不然要等 APK 那步才会报错
    & $Javac -encoding UTF-8 -source 8 -target 8 -Xlint:-options -classpath $ZxingJar -d $classes $DecodeSrc $CliSrc
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'javac 失败' -ForegroundColor Red
        exit 1
    }
    Test-Ok ($true) 'javac 通过（QrDecode.java + QrDecodeCli.java，未用 android.jar）'
} elseif (-not (Test-Path -LiteralPath (Join-Path $classes 'ds\app\QrDecode.class'))) {
    Write-Host "-NoBuild 但还没有编译产物：$classes" -ForegroundColor Red
    exit 1
}

$classpath = $classes + ';' + $ZxingJar
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$PairTool = Join-Path $PSScriptRoot 'pair-qr-sim.mjs'

# ── 逐个样本 × 两种模式 ─────────────────────────────────────────────────────
foreach ($case in $cases) {
    $file = Join-Path $Samples $case.file
    Write-Step "$($case.file)（$($case.note)）"
    if (-not (Test-Path -LiteralPath $file)) {
        Test-Ok $false "样本缺失：$($case.file)"
        continue
    }

    foreach ($mode in @('rgb', 'yuv')) {
        if ($mode -eq 'rgb') {
            $label = 'RGB（图库图片路径）'
            $javaArgs = @('-cp', $classpath, 'dstools.QrDecodeCli', $file)
        } else {
            $label = 'YUV rowStride+64（相机帧路径）'
            $javaArgs = @('-cp', $classpath, 'dstools.QrDecodeCli', '--yuv', '64', $file)
        }
        $out = & $Java @javaArgs 2>&1
        $exitCode = $LASTEXITCODE
        $text = (@($out) -join $NL).Trim()

        if ($case.expect.ok -ne $true) {
            # 反例样本（本身不是配对串）：解码必须成功解出那段文本，解不出才算失败
            Test-Ok ($exitCode -eq 0 -and $text -eq $case.uri) "$label 解出原文（反例：解出来不是配对串）"
        } else {
            Test-Ok ($exitCode -eq 0 -and $text -eq $case.uri) "$label 与预期逐字符相同"
        }
        if ($text -ne $case.uri) {
            Write-Host "        预期：$($case.uri)" -ForegroundColor DarkGray
            Write-Host "        实际：$text" -ForegroundColor DarkGray
        }
    }

    # L3 → L1：解出来的串再过一遍页面解析器，字段与 expected.json 对齐
    if ($nodeCmd -and (Test-Path -LiteralPath $PairTool)) {
        $parsed = & $nodeCmd.Source $PairTool --parse $case.uri 2>&1
        $parsedCode = $LASTEXITCODE
        $parsedText = (@($parsed) -join $NL)
        if ($case.expect.ok -eq $true) {
            $fieldsOk = $parsedCode -eq 0 -and
                $parsedText -match ('host\s*= ' + [regex]::Escape($case.expect.host)) -and
                $parsedText -match ('code\s*= ' + [regex]::Escape($case.expect.code))
            $expiredOk = $true
            if ($case.expect.PSObject.Properties.Name -contains 'expired') {
                $expiredOk = $parsedText -match ('expired\s*= ' + [string]$case.expect.expired)
            }
            Test-Ok ($fieldsOk -and $expiredOk) '解析器给出的字段与清单一致（host / code / expired）'
        } else {
            Test-Ok ($parsedCode -ne 0) "解析器按预期拒绝（reason=$($case.expect.reason)）"
        }
    }
}

# ── 汇总 ────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host ('-' * 46)
if ($fail -eq 0) {
    Write-Host "全部通过（$pass 项）" -ForegroundColor Green
    exit 0
}
Write-Host "通过 $pass　失败 $fail" -ForegroundColor Red
exit 1
