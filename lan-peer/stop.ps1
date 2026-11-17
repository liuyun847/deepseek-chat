<#
  stop.ps1 — 停止「电脑作为手机直连对端」（lan-peer）

  按状态文件找进程：
    1) 先读 lan-peer\logs\state.json 的 pid，并核对它的命令行里确实有 lan-peer\peer.mjs
    2) 状态文件缺失/失效时，退回「按命令行扫描 node 进程」
    3) 停完确认 TCP 端口已释放；5 秒还没退就强杀

  幂等：没在跑就打印「未在运行」并返回 0。
  注意：它停的是本机所有 lan-peer 实例（含手工 --data 起的调试实例），这是「停止服务」的应有语义。
  编码：本文件是 UTF-8 with BOM（Windows PowerShell 5.1 读无 BOM 的中文会乱码/报错）。
#>

[CmdletBinding()]
param(
    # 跳过「命令行里要有 lan-peer\peer.mjs」的核对
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$PeerDir = $PSScriptRoot
$LogDir = Join-Path $PeerDir 'logs'
$StartLog = Join-Path $LogDir 'start.log'
$StateFile = Join-Path $LogDir 'state.json'
$ServiceId = 'deepseek-chat-lan-peer'

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
        [System.IO.File]::AppendAllText($StartLog, $line + [Environment]::NewLine, $utf8NoBom)
    } catch {
    }
}

function Get-PeerState {
    try {
        if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
        $state = (Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8) | ConvertFrom-Json
        if ($state.service -ne $ServiceId) { return $null }
        return $state
    } catch {
        return $null
    }
}

function Test-PortBusy {
    param([int]$ListenPort)
    if ($ListenPort -le 0) { return $false }
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

# 进程命令行里有没有 lan-peer\peer.mjs（PID 会被系统复用，别按 PID 就乱杀）
function Test-OwnProcess {
    param([int]$OwnPid)
    try {
        $info = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $OwnPid) -ErrorAction Stop
        if (-not $info -or -not $info.CommandLine) { return $false }
        return ([string]$info.CommandLine -match 'lan-peer[\\/]peer\.mjs')
    } catch {
        return $false
    }
}

# 兜底：按命令行扫所有 node 进程
function Find-PeerProcesses {
    $ids = New-Object System.Collections.Generic.List[int]
    try {
        foreach ($info in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)) {
            if ($info.CommandLine -and ([string]$info.CommandLine -match 'lan-peer[\\/]peer\.mjs')) {
                $ids.Add([int]$info.ProcessId)
            }
        }
    } catch {
    }
    return @($ids | Sort-Object -Unique)
}

Write-LogLine '=== stop.ps1 开始 ==='

$state = Get-PeerState
$targets = New-Object System.Collections.Generic.List[int]
$listenPort = 0
if ($state -and [int]$state.pid -gt 0) {
    $listenPort = [int]$state.tcpPort
    if (Test-OwnProcess -OwnPid ([int]$state.pid)) {
        $targets.Add([int]$state.pid)
        Write-LogLine ('状态文件报告 PID ' + $state.pid + '（TCP ' + $state.tcpPort + '）')
    } else {
        Write-LogLine ('状态文件里的 PID ' + $state.pid + ' 已经不是 lan-peer（或已退出），改为扫描命令行')
    }
}

if ($targets.Count -eq 0) {
    foreach ($id in @(Find-PeerProcesses)) {
        $targets.Add($id)
    }
    if ($targets.Count -gt 0) {
        Write-LogLine ('按命令行查到 lan-peer 进程：' + ($targets -join ', '))
    }
}

if ($targets.Count -eq 0) {
    Write-LogLine '未在运行（没有 lan-peer 进程），无需停止（幂等）'
    Write-LogLine '=== stop.ps1 结束（无操作）==='
    exit 0
}

$stopped = 0
foreach ($targetPid in $targets) {
    if (-not (Test-OwnProcess -OwnPid $targetPid) -and -not $Force) {
        Write-LogLine ('跳过 PID ' + $targetPid + '：命令行程里没有 lan-peer\peer.mjs（确实要杀加 -Force）')
        continue
    }
    try {
        Stop-Process -Id $targetPid -ErrorAction Stop
        Write-LogLine ('已发送停止信号：PID ' + $targetPid)
        $stopped = $stopped + 1
    } catch {
        Write-LogLine ('PID ' + $targetPid + ' 停止失败：' + $_.Exception.Message)
    }
}

if ($stopped -eq 0) {
    Write-LogLine '没有停止任何进程'
    Write-LogLine '=== stop.ps1 结束（未停止）==='
    exit 0
}

# 等进程退干净（最多 5 秒），还活着就强杀
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $alive = @()
    foreach ($targetPid in $targets) {
        if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { $alive += $targetPid }
    }
    if ($alive.Count -eq 0) { break }
}
$alive = @()
foreach ($targetPid in $targets) {
    if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { $alive += $targetPid }
}
if ($alive.Count -gt 0) {
    Write-LogLine ('仍有进程未退出，强制结束：' + ($alive -join ', '))
    foreach ($targetPid in $alive) {
        try { Stop-Process -Id $targetPid -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Milliseconds 500
}

if ($listenPort -gt 0) {
    if (Test-PortBusy -ListenPort $listenPort) {
        Write-LogLine ('警告：TCP 端口 ' + $listenPort + ' 仍可连接（可能被别的程序接走了）')
    } else {
        Write-LogLine ('TCP 端口 ' + $listenPort + ' 已释放')
    }
}
Write-LogLine ('已停止 ' + $stopped + ' 个进程')
Write-LogLine '=== stop.ps1 结束（成功）==='
exit 0
