<#
  stop.ps1 — 停止同步服务（sync-server）

  按端口找监听进程并停止：
    1) 先看 /api/health 是不是同步服务（format=chat-demo-sync）
    2) 拿监听 PID（Get-NetTCPConnection，失败时退回 netstat）
    3) 只杀命令行里带 sync-server 与 server.mjs 的进程，避免误杀（-Force 跳过这层核对）

  注意：/api/health 不返回 pid（sync-server 刻意不对外泄漏主机名与路径），所以 PID 只能按端口反查。
  幂等：没在跑就打印「未在运行」并返回 0。
  编码：本文件是 UTF-8 with BOM（Windows PowerShell 5.1 读无 BOM 的中文会乱码/报错）。
#>

[CmdletBinding()]
param(
    # 端口；0 表示用 SYNC_PORT 环境变量，再没有就用 7788
    [int]$Port = 0,

    # 跳过「命令行里要有 sync-server 与 server.mjs」的核对
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ServerDir = $PSScriptRoot
$LogDir = Join-Path $ServerDir 'logs'
$StartLog = Join-Path $LogDir 'start.log'
$SyncFormat = 'chat-demo-sync'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
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
    }
}

if ($Port -le 0) {
    $parsedPort = 0
    if ([int]::TryParse([string]$env:SYNC_PORT, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $Port = $parsedPort
    } else {
        $Port = 7788
    }
}

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

# 端口上的监听 PID；优先 Get-NetTCPConnection（Win8+），不行退回 netstat 解析
function Get-ListenerPids {
    param([int]$ListenPort)
    $ids = New-Object System.Collections.Generic.List[int]
    $done = $false
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop)
        foreach ($conn in $conns) { $ids.Add([int]$conn.OwningProcess) }
        $done = $true
    } catch {
        $done = $false
    }
    if (-not $done) {
        $pattern = '^\s*TCP\s+\S+:' + $ListenPort + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
        foreach ($line in @(& netstat -ano -p tcp 2>$null)) {
            if ($line -match $pattern) { $ids.Add([int]$Matches[1]) }
        }
    }
    return @($ids | Sort-Object -Unique)
}

# 进程命令行是不是本服务（PID 可能被系统复用，别按端口就乱杀）
function Test-OwnProcess {
    param([int]$OwnPid)
    try {
        $info = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $OwnPid) -ErrorAction Stop
        if (-not $info -or -not $info.CommandLine) { return $false }
        $cmd = [string]$info.CommandLine
        return ($cmd -match 'sync-server' -and $cmd -match 'server\.mjs')
    } catch {
        return $false
    }
}

Write-LogLine ('=== stop.ps1 开始（端口 {0}）===' -f $Port)

$health = Get-Health -ListenPort $Port
if ($health -and $health.format -eq $SyncFormat) {
    Write-LogLine ('/api/health 确认是同步服务（format={0}，记录 {1} 条）' -f $health.format, $health.records)
} elseif ($health) {
    Write-LogLine '提醒：该端口有响应但不是同步服务（format 不符），后面按端口反查'
}

$targets = @(Get-ListenerPids -ListenPort $Port)
if ($targets.Count -gt 0) {
    Write-LogLine ('按端口查到监听 PID：' + ($targets -join ', '))
}

if ($targets.Count -eq 0) {
    Write-LogLine '未在运行（端口上没有监听进程），无需停止（幂等）'
    Write-LogLine '=== stop.ps1 结束（无操作）==='
    exit 0
}

$stopped = 0
foreach ($targetPid in $targets) {
    $ours = Test-OwnProcess -OwnPid $targetPid
    if (-not $ours -and -not $Force) {
        Write-LogLine ('跳过 PID {0}：它的命令行里没有 sync-server 与 server.mjs，不像是同步服务（确实要杀加 -Force）' -f $targetPid)
        continue
    }
    try {
        Stop-Process -Id $targetPid -ErrorAction Stop
        Write-LogLine ('已发送停止信号：PID {0}' -f $targetPid)
        $stopped = $stopped + 1
    } catch {
        Write-LogLine ('PID {0} 停止失败：{1}' -f $targetPid, $_.Exception.Message)
    }
}

if ($stopped -eq 0) {
    Write-LogLine '没有停止任何进程'
    Write-LogLine '=== stop.ps1 结束（未停止）==='
    exit 0
}

# 等端口释放，最多 5 秒；还占着就强杀
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $still = @(Get-ListenerPids -ListenPort $Port)
    if ($still.Count -eq 0) { break }
}

$still = @(Get-ListenerPids -ListenPort $Port)
if ($still.Count -gt 0) {
    Write-LogLine ('端口仍被占用，强制结束：' + ($still -join ', '))
    foreach ($targetPid in $still) {
        try { Stop-Process -Id $targetPid -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Milliseconds 500
}

$left = @(Get-ListenerPids -ListenPort $Port)
if ($left.Count -gt 0) {
    Write-LogLine ('失败：端口 {0} 仍有监听进程 {1}' -f $Port, ($left -join ', '))
    exit 1
}
Write-LogLine ('已停止：端口 {0} 已释放' -f $Port)
Write-LogLine '=== stop.ps1 结束（成功）==='
exit 0
