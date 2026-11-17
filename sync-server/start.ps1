<#
  start.ps1 — 启动同步服务（sync-server，HTTP 同步；默认 127.0.0.1:7788）

  做三件事：
    1) 已经在跑（/api/health 返回 format=chat-demo-sync）就直接返回 0，不重复启动（幂等）
    2) 否则用 node 以隐藏窗口启动 sync-server\server.mjs --port <端口>
    3) 轮询 /api/health 通了才算成功；失败时打印原因并给出查看日志的办法，退出码 1

  只监听回环：不传 --host，server.mjs 默认就是 127.0.0.1。手机走 P2P（lan-peer）不经过它，
  对局域网开放只会多一个读写全库的口子；真要开放得自己加 --host 0.0.0.0 并配 --token。

  为什么不用 -RedirectStandardOutput/-RedirectStandardError 收服务日志（刻意）：
    Start-Process 一旦带重定向，就会以「继承句柄」的方式拉起子进程，于是长驻的 node 会把
    powershell 自己的 stderr 文件（也就是开机自启脚本里 2>> 的那个 autostart.err.log）
    一直占着。实测（2026-11-17）：在 node 运行期间对那个文件 Delete / 以 Append 打开都报
    「being used by another process」，下一次自启的 2>> 就打不开、整个 vbs 变成静默空转。
    这正是 local-server 那套写法把重定向去掉的原因，这里沿用：不带 -Redirect。
    代价是 server.mjs 的输出进隐藏控制台、不落文件；要看实时日志就前台跑一次
      node sync-server\server.mjs --port 7788
    （记录条数、会话数这些关键数字 /api/health 里都有，start.log 每次启动也记一行。）

  退出码：0 = 服务在跑（本次启动或本来就在跑）；1 = 启动失败
  日志：sync-server\logs\start.log（每次追加一行结果，本脚本写）
  编码：本文件是 UTF-8 with BOM。Windows PowerShell 5.1 读无 BOM 的中文会按 cp936 解码并吞掉换行。
  兼容：Windows PowerShell 5.1 与 pwsh 7 都能跑（没用 7 专有语法）；开机自启的 vbs 用 5.1。
#>

[CmdletBinding()]
param(
    # 监听端口；0 表示用 SYNC_PORT 环境变量，再没有就用 7788
    [int]$Port = 0,

    # 等 /api/health 就绪的最长秒数
    [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'

$ServerDir = $PSScriptRoot
$LogDir = Join-Path $ServerDir 'logs'
$StartLog = Join-Path $LogDir 'start.log'
$SyncFormat = 'chat-demo-sync'

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

# 端口：参数 > SYNC_PORT 环境变量 > 7788（与 server.mjs 的默认值一致）
if ($Port -le 0) {
    $parsedPort = 0
    if ([int]::TryParse([string]$env:SYNC_PORT, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $Port = $parsedPort
    } else {
        $Port = 7788
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

$health = $null
if (Test-PortBusy -ListenPort $Port) { $health = Get-Health -ListenPort $Port }
if ($health -and $health.format -eq $SyncFormat) {
    Write-LogLine ('已在运行：http://127.0.0.1:{0}/api/health （format={1}，记录 {2} 条，会话 {3} 个）' -f $Port, $health.format, $health.records, $health.sessions)
    Write-LogLine '无需重复启动（幂等），退出码 0'
    exit 0
}

if (Test-PortBusy -ListenPort $Port) {
    Write-LogLine ('失败：端口 {0} 已被其它程序占用（/api/health 不是同步服务的响应）。' -f $Port)
    Write-LogLine '换个端口：$env:SYNC_PORT=7798 后再运行；或 netstat -ano | findstr :端口 查出占用进程'
    exit 1
}

$serverScript = Join-Path $ServerDir 'server.mjs'
if (-not (Test-Path -LiteralPath $serverScript)) {
    Write-LogLine ('失败：找不到 {0}' -f $serverScript)
    exit 1
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-LogLine '失败：PATH 里找不到 node.exe —— 先安装 Node.js 22+ 并确保 node 可执行'
    exit 1
}
$nodePath = $nodeCmd.Source

Write-LogLine ('启动：{0} {1} --port {2}' -f $nodePath, $serverScript, $Port)
Write-LogLine ('工作目录 {0}，隐藏窗口；不带 -Redirect（见文件头：避免长驻 node 占住自启的 stderr 文件）' -f $ServerDir)

try {
    $proc = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $serverScript + '"'), '--port', [string]$Port) `
        -WorkingDirectory $ServerDir -WindowStyle Hidden -PassThru
} catch {
    Write-LogLine ('失败：Start-Process 出错：' + $_.Exception.Message)
    exit 1
}
Write-LogLine ('已拉起 PID {0}，等待 /api/health 就绪（最多 {1} 秒）' -f $proc.Id, $TimeoutSeconds)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$health = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 150
    # 端口还没监听时不要打 HTTP：PS 5.1 的 Invoke-WebRequest 连不上要磨 1-2 秒，冷启动会被它拖慢
    $health = $null
    if (Test-PortBusy -ListenPort $Port) { $health = Get-Health -ListenPort $Port }
    if ($health -and $health.format -eq $SyncFormat) { break }
    if ($proc.HasExited) { break }
}

if (-not ($health -and $health.format -eq $SyncFormat)) {
    Write-LogLine ('失败：{0} 秒内 /api/health 没有就绪（要求 format={1}）' -f $TimeoutSeconds, $SyncFormat)
    if ($proc.HasExited) {
        Write-LogLine ('进程已退出，退出码 ' + $proc.ExitCode)
    } else {
        Write-LogLine ('进程仍在（PID {0}），但接口不通' -f $proc.Id)
    }
    Write-LogLine '看原因：前台跑一次 node sync-server\server.mjs --port 端口（输出不在文件里，这是刻意的）'
    exit 1
}

Write-LogLine ('就绪：http://127.0.0.1:{0}/api/health （PID {1}，format={2}，记录 {3} 条，会话 {4} 个）' -f $Port, $proc.Id, $health.format, $health.records, $health.sessions)
Write-LogLine '页面侧：浏览器打开 http://127.0.0.1:7789 后，同步地址留空即经 /sync/api 用本服务'
Write-LogLine '停止：.\sync-server\stop.ps1'
Write-LogLine '=== start.ps1 结束（成功）==='
exit 0
