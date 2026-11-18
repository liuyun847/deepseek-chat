<#
  start.ps1 — 启动本机 Web 服务（静态托管 dist/ + 反向代理 DeepSeek API）

  做三件事：
    1) 已经在跑（/api/health 返回本服务标识）就直接返回 0，不重复启动（幂等）
    2) 否则用 node 以隐藏窗口启动 local-server\server.mjs
    3) 轮询 /api/health 通了才算成功；失败时打印原因和日志尾部，退出码 1

  退出码：0 = 服务在跑（本次启动或本来就在跑）；1 = 启动失败
  日志：local-server\logs\start.log（每次追加一行结果）、server.log（服务自己的日志）
  编码：本文件是 UTF-8 with BOM。Windows PowerShell 5.1 读无 BOM 的中文会按 cp936 解码并吞掉换行。
  兼容：Windows PowerShell 5.1 与 pwsh 7 都能跑（没用 7 专有语法）；开机自启的 vbs 用 5.1。
#>

[CmdletBinding()]
param(
    # 监听端口；0 表示用 PORT 环境变量，再没有就用 7789
    [int]$Port = 0,

    # 等 /api/health 就绪的最长秒数
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

$ServerDir = $PSScriptRoot
$Root = Split-Path -Parent $ServerDir
$LogDir = Join-Path $ServerDir 'logs'
$StartLog = Join-Path $LogDir 'start.log'
$ServerLog = Join-Path $LogDir 'server.log'
$ServiceId = 'deepseek-chat-local'

# 控制台按 UTF-8 输出，避免中文乱码（失败不影响主流程）
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# 日志一律用 .NET 写：Add-Content 在 5.1 下会往新文件塞 BOM
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-LogLine {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) {
            New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        }
        [System.IO.File]::AppendAllText($StartLog, $line + "`r`n", $utf8NoBom)
    } catch {
        # 日志写不了不影响启动
    }
}

# 端口：参数 > PORT 环境变量 > 7789
if ($Port -le 0) {
    $parsedPort = 0
    if ([int]::TryParse([string]$env:PORT, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $Port = $parsedPort
    } else {
        $Port = 7789
    }
}

# 取 /api/health；不通时返回 $null（不抛异常）
function Get-Health {
    param([int]$ListenPort)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 `
            -Uri ('http://127.0.0.1:{0}/api/health' -f $ListenPort)
        if ($response.StatusCode -ne 200) { return $null }
        return ($response.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

# 端口上有没有人在听（不依赖 Get-NetTCPConnection，5.1 也能跑）
function Test-PortBusy {
    param([int]$ListenPort)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $ListenPort, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

Write-LogLine ('=== start.ps1 开始（端口 {0}）===' -f $Port)

$health = Get-Health -ListenPort $Port
if ($health -and $health.service -eq $ServiceId) {
    Write-LogLine ('已在运行：http://127.0.0.1:{0}/ （PID {1}，key 已配置：{2}）' -f $Port, $health.pid, $health.keyConfigured)
    Write-LogLine '无需重复启动（幂等），退出码 0'
    exit 0
}

if (Test-PortBusy -ListenPort $Port) {
    Write-LogLine ('失败：端口 {0} 已被其它程序占用（/api/health 不是本机服务的响应）。' -f $Port)
    Write-LogLine '换个端口：$env:PORT=7790 后再运行；或先用 netstat -ano | findstr :端口 查出占用进程'
    exit 1
}

$distIndex = Join-Path $Root 'dist\index.html'
if (-not (Test-Path -LiteralPath $distIndex)) {
    Write-LogLine '提醒：dist\index.html 不存在，页面会 404。先构建：pnpm --config.shell-emulator=true build:web'
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-LogLine '失败：PATH 里找不到 node.exe —— 先安装 Node.js 22+ 并确保 node 可执行'
    exit 1
}
$nodePath = $nodeCmd.Source

$env:PORT = [string]$Port
# 同步上游：存在自签证书时默认走 HTTPS 并用它做 CA 校验（与 sync-server/start.ps1 配套）
$syncCert = Join-Path (Split-Path -Parent $ServerDir) 'sync-server\tls\cert.pem'
$syncPort = if ($env:SYNC_PORT) { $env:SYNC_PORT } else { '7788' }
if (-not $env:SYNC_UPSTREAM -and (Test-Path -LiteralPath $syncCert)) {
    $env:SYNC_UPSTREAM = ('https://127.0.0.1:{0}' -f $syncPort)
    $env:SYNC_CA_FILE = $syncCert
    Write-LogLine ('同步上游：{0}（CA {1}）' -f $env:SYNC_UPSTREAM, $env:SYNC_CA_FILE)
}
$serverScript = Join-Path $ServerDir 'server.mjs'
Write-LogLine ('启动：{0} {1}' -f $nodePath, $serverScript)
Write-LogLine ('工作目录 {0}，隐藏窗口，日志 {1}' -f $ServerDir, $ServerLog)

try {
    $proc = Start-Process -FilePath $nodePath -ArgumentList @($serverScript) `
        -WorkingDirectory $ServerDir -WindowStyle Hidden -PassThru
} catch {
    Write-LogLine ('失败：Start-Process 出错：' + $_.Exception.Message)
    exit 1
}
Write-LogLine ('已拉起 PID {0}，等待 /api/health 就绪（最多 {1} 秒）' -f $proc.Id, $TimeoutSeconds)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$health = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $health = Get-Health -ListenPort $Port
    if ($health -and $health.service -eq $ServiceId) { break }
    if ($proc.HasExited) { break }
}

if (-not ($health -and $health.service -eq $ServiceId)) {
    Write-LogLine ('失败：{0} 秒内 /api/health 没有就绪' -f $TimeoutSeconds)
    if ($proc.HasExited) {
        Write-LogLine ('进程已退出，退出码 ' + $proc.ExitCode + '（端口被占用时通常是 2）')
    } else {
        Write-LogLine ('进程仍在（PID {0}），但接口不通，见下面日志' -f $proc.Id)
    }
    if (Test-Path -LiteralPath $ServerLog) {
        $tail = @(Get-Content -LiteralPath $ServerLog -Tail 10 -ErrorAction SilentlyContinue)
        foreach ($line in $tail) { Write-Host ('  | ' + $line) }
    }
    exit 1
}

Write-LogLine ('就绪：http://127.0.0.1:{0}/ （PID {1}）' -f $Port, $health.pid)
Write-LogLine ('API key：' + $(if ($health.keyConfigured) { '已配置，来源 ' + $health.keySource } else { '未配置（页面能开，代理路由返回 503）' }))
Write-LogLine ('前端产物：' + $(if ($health.distReady) { 'dist/ 已就绪' } else { 'dist/ 缺 index.html，先构建' }))
if ($health.distHasBakedKey) {
    Write-LogLine '警告：dist/ 里含明文 API key（那是给 APK 用的构建），网页产物请用 pnpm build:web 重新构建'
}
Write-LogLine '停止：.\local-server\stop.ps1'
Write-LogLine '=== start.ps1 结束（成功）==='
exit 0
