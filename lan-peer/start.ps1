<#
  start.ps1 — 启动「电脑作为手机直连对端」（lan-peer）

  做四件事：
    1) 已经有健康实例在跑（状态文件 state.json 新鲜 + TCP 端口可连）就直接返回 0，不重复启动（幂等）
    2) 否则用 node 以隐藏窗口启动 lan-peer\peer.mjs，口令通过环境变量传给子进程（不进命令行）
    3) 轮询状态文件与 TCP 端口，起来了才算成功；失败时打印原因与日志尾部，退出码 1
    4) 每次结果追加一行到 lan-peer\logs\start.log

  口令从哪来（按优先级）：
    -Passphrase <口令>  →  $env:LAN_PASSPHRASE  →  <仓库根>\.secrets\lan-passphrase.txt（单行）
  开机自启用的 vbs 没有参数，所以实际走的是后两条；建议把口令写进 .secrets\lan-passphrase.txt
  （该目录已被 .gitignore 忽略）。口令不会出现在进程命令行里。

  退出码：0 = 服务在跑；1 = 启动失败；2 = 参数/口令问题
  日志：lan-peer\logs\start.log（启停结果）、peer.log（服务日志）、console.log / console.log.err（本次运行的 stdout / stderr）
  编码：本文件是 UTF-8 with BOM。Windows PowerShell 5.1 读无 BOM 的中文会按 cp936 解码并吞掉换行。
  兼容：Windows PowerShell 5.1 与 pwsh 7 都能跑；开机自启的 vbs 用 5.1。
#>

[CmdletBinding()]
param(
    # TCP 监听端口；0 = 随机（推荐，随广播告知对端）
    [int]$Port = 0,

    # 发现端口，必须与手机端一致
    [int]$UdpPort = 47823,

    # 数据文件；空 = lan-peer 的默认值（..\sync-server\data\sync-data.json）
    [string]$Data = '',

    # 设备名；空 = 主机名
    [string]$Name = '',

    # 多网卡时指定广播网卡（网卡地址或该网段广播地址）
    [string]$Iface = '',

    # 口令；空则按文件头写的顺序回退
    [string]$Passphrase = '',

    # 等就绪的最长秒数
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

$PeerDir = $PSScriptRoot
$Root = Split-Path -Parent $PeerDir
$LogDir = Join-Path $PeerDir 'logs'
$StartLog = Join-Path $LogDir 'start.log'
$PeerLog = Join-Path $LogDir 'peer.log'
$ConsoleLog = Join-Path $LogDir 'console.log'
$StateFile = Join-Path $LogDir 'state.json'
$PassFile = Join-Path $Root '.secrets\lan-passphrase.txt'
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
        # 日志写不了不影响启动
    }
}

# 端口上有没有人在听（5.1 与 7 都能跑，不依赖 Get-NetTCPConnection）
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

# 读状态文件；读不到或不是本服务返回 $null
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

# 进程是否还活着
function Test-Alive {
    param([int]$TargetPid)
    if ($TargetPid -le 0) { return $false }
    try {
        $null = Get-Process -Id $TargetPid -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# 健康判定：任务约定「TCP 端口起来 + 广播已发」，两条都要满足
# 返回 @{ Ok = $bool; Reason = '...' }
function Get-Health {
    $state = Get-PeerState
    if (-not $state) { return @{ Ok = $false; Reason = '状态文件不存在或不是本服务' } }
    if (-not (Test-Alive -TargetPid ([int]$state.pid))) { return @{ Ok = $false; Reason = ('进程 ' + $state.pid + ' 已退出（状态文件是上次运行留下的）') } }
    if ([int]$state.tcpPort -le 0) { return @{ Ok = $false; Reason = '状态文件里还没有 TCP 端口' } }
    if (-not (Test-PortBusy -ListenPort ([int]$state.tcpPort))) { return @{ Ok = $false; Reason = ('TCP 端口 ' + $state.tcpPort + ' 连不上') } }
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$state.lastAnnounceAt
    if ($age -gt 15000) { return @{ Ok = $false; Reason = ('广播已 ' + [math]::Round($age / 1000) + ' 秒没发（每 4 秒一轮）') } }
    if (-not $state.announceOk) { return @{ Ok = $false; Reason = '最近一轮广播一个网卡都没发出去' } }
    return @{ Ok = $true; Reason = ('pid=' + $state.pid + ' tcp=' + $state.tcpPort + ' 记录=' + $state.records + ' 已配对=' + $state.paired) }
}

Write-LogLine ('=== start.ps1 开始（TCP 端口 ' + $Port + '，UDP ' + $UdpPort + '）===')

$health = Get-Health
if ($health.Ok) {
    Write-LogLine ('已在运行：' + $health.Reason)
    Write-LogLine '无需重复启动（幂等），退出码 0'
    exit 0
}
if ($health.Reason) {
    Write-LogLine ('当前没有健康实例：' + $health.Reason)
}

# 有进程活着但自检不过（广播停了 / 卡住）：先停掉它。
# 否则会起出第二份实例，两份抢同一个数据文件与同一个设备 id，互相看不见还互相覆盖。
$stale = Get-PeerState
if ($stale -and [int]$stale.pid -gt 0 -and (Test-Alive -TargetPid ([int]$stale.pid)) -and (Test-OwnProcess -OwnPid ([int]$stale.pid))) {
    Write-LogLine ('停掉自检不过的旧实例 PID ' + $stale.pid)
    try {
        Stop-Process -Id ([int]$stale.pid) -ErrorAction Stop
        Start-Sleep -Milliseconds 600
    } catch {
        Write-LogLine ('旧实例停不掉：' + $_.Exception.Message)
    }
}

# ── 口令 ──────────────────────────────────────────────────────────────────
$secret = $Passphrase
if (-not $secret) { $secret = [string]$env:LAN_PASSPHRASE }
if (-not $secret -and (Test-Path -LiteralPath $PassFile)) {
    try {
        $secret = ([System.IO.File]::ReadAllText($PassFile, $utf8NoBom)).Trim()
    } catch {
        Write-LogLine ('口令文件读不出来：' + $_.Exception.Message)
    }
}
if (-not $secret) {
    Write-LogLine '失败：没有口令。三种给法任选一种：'
    Write-LogLine '  1) .\lan-peer\start.ps1 -Passphrase <至少 8 位>'
    Write-LogLine '  2) $env:LAN_PASSPHRASE = <口令> 后再运行'
    Write-LogLine ('  3) 把口令写进 ' + $PassFile + '（单行，开机自启要用这条）')
    exit 2
}
if ($secret.Trim().Length -lt 8) {
    Write-LogLine '失败：口令太短（至少 8 位，与手机端一致）'
    exit 2
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-LogLine '失败：PATH 里找不到 node.exe —— 先装 Node.js 22+ 并确保 node 可执行'
    exit 1
}
$nodePath = $nodeCmd.Source

# 共享的 TypeScript 模块要先编译出 JS（Node 不能直接跑带 .js 说明符的 .ts，见 README）
$buildMarker = Join-Path $PeerDir 'build\src\services\sync\lan\crypto.js'
if (-not (Test-Path -LiteralPath $buildMarker)) {
    $tsc = Join-Path $Root 'node_modules\.bin\tsc.cmd'
    if (-not (Test-Path -LiteralPath $tsc)) {
        Write-LogLine '失败：编译产物缺失，且找不到 node_modules\.bin\tsc.cmd（先 pnpm install）'
        exit 1
    }
    Write-LogLine '编译共享 TS 模块（lan-peer\tsconfig.json）'
    & $tsc -p (Join-Path $PeerDir 'tsconfig.json')
    if ($LASTEXITCODE -ne 0) {
        Write-LogLine '失败：tsc 编译不过，见上面输出'
        exit 1
    }
}

# ── 启动 ──────────────────────────────────────────────────────────────────
$peerScript = Join-Path $PeerDir 'peer.mjs'
$argList = @($peerScript, '--udp-port', [string]$UdpPort)
if ($Port -gt 0) { $argList += @('--port', [string]$Port) }
if ($Data) { $argList += @('--data', $Data) }
if ($Name) { $argList += @('--name', $Name) }
if ($Iface) { $argList += @('--iface', $Iface) }

# 口令走环境变量而不是命令行：命令行会被别的进程（任务管理器、wmic）看到
$env:LAN_PASSPHRASE = $secret.Trim()
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
Write-LogLine ('启动：' + $nodePath + ' ' + ($argList -join ' '))
try {
    $proc = Start-Process -FilePath $nodePath -ArgumentList $argList -WorkingDirectory $PeerDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $ConsoleLog -RedirectStandardError ($ConsoleLog + '.err')
} catch {
    Remove-Item Env:\LAN_PASSPHRASE -ErrorAction SilentlyContinue
    Write-LogLine ('失败：Start-Process 出错：' + $_.Exception.Message)
    exit 1
}
Remove-Item Env:\LAN_PASSPHRASE -ErrorAction SilentlyContinue
Write-LogLine ('已拉起 PID ' + $proc.Id + '，等待就绪（最多 ' + $TimeoutSeconds + ' 秒）')

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$health = @{ Ok = $false; Reason = '还没写状态文件' }
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $health = Get-Health
    if ($health.Ok) { break }
    if ($proc.HasExited) { break }
}

if (-not $health.Ok) {
    Write-LogLine ('失败：' + $TimeoutSeconds + ' 秒内没有就绪（' + $health.Reason + '）')
    if ($proc.HasExited) {
        Write-LogLine ('进程已退出，退出码 ' + $proc.ExitCode + '（口令问题通常 2）')
    } else {
        Write-LogLine ('进程仍在（PID ' + $proc.Id + '），但自检不过，见下面日志')
    }
    foreach ($file in @(($ConsoleLog + '.err'), $ConsoleLog, $PeerLog)) {
        if (Test-Path -LiteralPath $file) {
            Write-Host ('  | ' + $file)
            foreach ($line in @(Get-Content -LiteralPath $file -Tail 8 -Encoding UTF8 -ErrorAction SilentlyContinue)) {
                Write-Host ('  | ' + $line)
            }
        }
    }
    exit 1
}

Write-LogLine ('就绪：' + $health.Reason)
$state = Get-PeerState
if ($state) {
    Write-LogLine ('口令：已配置（广播指纹 pairTag=' + $state.pairTag + '）')
    Write-LogLine ('数据文件：' + $state.dataFile)
}
Write-LogLine '手机侧：设置 → 手机直连 → 填同一个口令（≥8 位）→ 保存并配对；「发现的设备」里应出现本机'
Write-LogLine '停止：.\lan-peer\stop.ps1'
Write-LogLine '=== start.ps1 结束（成功）==='
exit 0
