#requires -Version 7
<#
.SYNOPSIS
    一次性安装本项目构建 APK 所需的最小 Android 工具链。

.DESCRIPTION
    只装三样东西，不装 cmdline-tools / sdkmanager / Gradle：
      - Temurin 兼容的 OpenJDK 17（华为云镜像）
      - build-tools 35.0.1（aapt2 / d8 / zipalign / apksigner）
      - platforms;android-35（android.jar，编译期 API 存根）

    本项目零第三方依赖，APK 用 aapt2 + javac + d8 + apksigner 手工构建，
    因此完全不需要 Gradle 与任何 Maven 制品，规避国内网络拉依赖的失败风险。

    产物落在 $env:USERPROFILE\.devtools\ 下，不污染工作区。
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ── 配置 ────────────────────────────────────────────────────────────────────
$Root    = Join-Path $env:USERPROFILE '.devtools'
$JdkDir  = Join-Path $Root 'jdk17'
$Sdk     = Join-Path $Root 'android-sdk'
$BtVer   = '35.0.1'
$BtDir   = Join-Path $Sdk "build-tools\$BtVer"
$PlatDir = Join-Path $Sdk 'platforms\android-35'
$Tmp     = Join-Path $Root '_dl'

$BtUrl   = "https://dl.google.com/android/repository/build-tools_r${BtVer}_windows.zip"
$PlatUrl = 'https://dl.google.com/android/repository/platform-35_r02.zip'
# 华为云镜像上的 OpenJDK 17（dl.google.com 无 JDK）
$JdkUrl  = 'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip'

# ── 辅助函数 ────────────────────────────────────────────────────────────────
function Get-Remote {
    param([string]$Url, [string]$Dest)
    if (Test-Path $Dest) {
        Write-Host "  跳过（已存在）: $(Split-Path $Dest -Leaf)" -ForegroundColor DarkGray
        return
    }
    Write-Host "  下载: $Url" -ForegroundColor Cyan
    & curl.exe -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 -sS -o $Dest $Url
    if ($LASTEXITCODE -ne 0) { throw "下载失败: $Url" }
    $mb = [math]::Round((Get-Item $Dest).Length / 1MB, 1)
    Write-Host "  完成: $(Split-Path $Dest -Leaf) ($mb MB)" -ForegroundColor Green
}

function Expand-To {
    <# 官方 zip 内部有单一顶层目录（如 android-15/），这里剥掉它再落到目标路径。 #>
    param([string]$Zip, [string]$Target)
    $staging = Join-Path $Tmp ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    try {
        Expand-Archive -Path $Zip -DestinationPath $staging -Force
        $top = @(Get-ChildItem -LiteralPath $staging)
        $src = if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $top[0].FullName } else { $staging }
        New-Item -ItemType Directory -Force -Path $Target | Out-Null
        Copy-Item -Path (Join-Path $src '*') -Destination $Target -Recurse -Force
    }
    finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-Ready {
    param([string]$Label, [string[]]$Files)
    $missing = $Files | Where-Object { -not (Test-Path $_) }
    if ($missing) {
        Write-Host "  [缺失] $($missing -join ', ')" -ForegroundColor Red
        return $false
    }
    Write-Host "  [就绪] $Label" -ForegroundColor Green
    return $true
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $Root, $JdkDir, $BtDir, $PlatDir, $Tmp | Out-Null

Write-Host "`n[1/3] JDK 17" -ForegroundColor Yellow
Get-Remote $JdkUrl (Join-Path $Tmp 'jdk17.zip')
if (-not (Test-Path (Join-Path $JdkDir 'bin\javac.exe'))) {
    Expand-To (Join-Path $Tmp 'jdk17.zip') $JdkDir
}
$null = Test-Ready 'JDK' @((Join-Path $JdkDir 'bin\javac.exe'), (Join-Path $JdkDir 'bin\keytool.exe'))

Write-Host "`n[2/3] build-tools $BtVer" -ForegroundColor Yellow
Get-Remote $BtUrl (Join-Path $Tmp 'build-tools.zip')
if (-not (Test-Path (Join-Path $BtDir 'aapt2.exe'))) {
    Expand-To (Join-Path $Tmp 'build-tools.zip') $BtDir
}
$null = Test-Ready 'build-tools' @(
    (Join-Path $BtDir 'aapt2.exe'), (Join-Path $BtDir 'd8.bat'),
    (Join-Path $BtDir 'zipalign.exe'), (Join-Path $BtDir 'apksigner.bat')
)

Write-Host "`n[3/3] platform android-35" -ForegroundColor Yellow
Get-Remote $PlatUrl (Join-Path $Tmp 'platform-35.zip')
if (-not (Test-Path (Join-Path $PlatDir 'android.jar'))) {
    Expand-To (Join-Path $Tmp 'platform-35.zip') $PlatDir
}
$null = Test-Ready 'platform' @((Join-Path $PlatDir 'android.jar'))

# ── 清理下载缓存 ────────────────────────────────────────────────────────────
Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue

# ── 输出环境变量，供 build-apk.ps1 复用 ─────────────────────────────────────
Write-Host "`n工具链就绪。构建脚本会自动探测以下位置：" -ForegroundColor Cyan
Write-Host "  JAVA_HOME  -> $JdkDir"
Write-Host "  ANDROID_SDK -> $Sdk`n"

# 供本会话后续命令使用
$env:JAVA_HOME    = $JdkDir
$env:ANDROID_SDK  = $Sdk
