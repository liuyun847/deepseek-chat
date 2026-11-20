<#
  start.ps1 — 启动同步服务（sync-server；默认 127.0.0.1:7788）

  做三件事：
    1) 已经在跑（/api/health 返回 format=chat-demo-sync）就直接返回 0，不重复启动（幂等）
    2) 否则用 node 以隐藏窗口启动 sync-server\server.mjs --port <端口>
    3) 轮询 /api/health 通了才算成功；失败时打印原因并给出查看日志的办法，退出码 1

  HTTPS：
    默认优先使用 sync-server\tls\cert.pem + key.pem；文件不存在时尝试调用
    node sync-server\gen-cert.mjs 生成一次。openssl 不要求在 PATH 里：PATH 上找不到
    就依次探测 Git for Windows 等常见安装位置，找到后把它的目录前置进 PATH 再生成。
    生成不了就退回 HTTP 并打印警告。也可用 -TlsCert / -TlsKey 显式指定。

    为什么「本机服务已经在跑」时不自动生成：证书一出现本脚本就改用 HTTPS，而本机服务
    （local-server，默认 7789）是在它自己启动时一次性采样这张证书来决定上游协议的，
    之后不会跟随（见 local-server\start.ps1）。这时静默生成 = 让它的 http 上游打在一个
    TLS 端口上，/sync/api 立刻变 502。所以探测到 7789 已在监听就跳过生成、只打印手动
    切换步骤。要切 HTTPS：先 .\local-server\stop.ps1，再 node sync-server\gen-cert.mjs，
    然后重启 sync-server 与 local-server（两个都得重启，只重启一个反而会错配）。

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
    [int]$TimeoutSeconds = 15,

    # TLS 证书/私钥；留空则用 tls\cert.pem + tls\key.pem 或自动生成
    [string]$TlsCert = '',

    [string]$TlsKey = ''
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
    $uri = ('{0}://127.0.0.1:{1}/api/health' -f $Scheme, $ListenPort)
    # HTTPS（自签）走 curl -k：PowerShell 5.1 与 7 都没法用脚本块做证书回调
    # （回调跑在 TLS 握手的线程池线程上，没有 Runspace，设了 ServerCertificateValidationCallback
    # 也照样握手失败）。实测 2026-11-20：服务已在 HTTPS 上跑、curl -k 能拿到 200，但
    # Invoke-WebRequest 一直报「基础连接已经关闭」→ 就绪判断永远失败、幂等分支还会误判成端口被占。
    # curl.exe 是 Windows 10 1803+ 自带的（C:\Windows\System32\curl.exe），没有就退回 Invoke-WebRequest。
    if ($UseTls) {
        $curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curlCmd) {
            try {
                $raw = & $curlCmd.Source -s -k --max-time 3 $uri
                if ($LASTEXITCODE -eq 0 -and $raw) { return ($raw | ConvertFrom-Json) }
            } catch { }
            return $null
        }
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $uri
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

# ── HTTPS ───────────────────────────────────────────────────────────────────
# 这段刻意排在 Test-PortBusy 之后：「本机服务是否已在跑」要靠它判断。
# $Scheme 一旦定下就不再改，Get-Health、启动参数与日志都读它。

<#
  .SYNOPSIS  找一个可用的 openssl.exe：先看 PATH，再探测常见安装位置（Windows 不自带）。
  .OUTPUTS   string：openssl.exe 的绝对路径；找不到返回空串。
  .NOTES     副作用：找到的目录若不在 PATH 里，会前置到本进程的 $env:PATH ——
             gen-cert.mjs 用 spawnSync('openssl') 走 PATH 找它，不接受绝对路径参数。
#>
function Resolve-OpenSsl {
    $onPath = Get-Command openssl -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))
    $relatives = @(
        'Git\usr\bin\openssl.exe',
        'Git\mingw64\bin\openssl.exe',
        'OpenSSL-Win64\bin\openssl.exe',
        'OpenSSL-Win32\bin\openssl.exe'
    )
    foreach ($root in $roots) {
        if (-not $root) { continue }
        foreach ($rel in $relatives) {
            $candidate = Join-Path $root $rel
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return ''
}

if (-not $TlsCert) { $TlsCert = Join-Path $ServerDir 'tls\cert.pem' }
if (-not $TlsKey) { $TlsKey = Join-Path $ServerDir 'tls\key.pem' }
if (-not $env:SYNC_TLS_CERT -and -not $env:SYNC_TLS_KEY) {
    if (-not ((Test-Path -LiteralPath $TlsCert) -and (Test-Path -LiteralPath $TlsKey))) {
        $genScript = Join-Path $ServerDir 'gen-cert.mjs'
        $nodeForCert = Get-Command node -ErrorAction SilentlyContinue
        # 本机服务的端口：默认 7789，PORT 环境变量可改（与 local-server/start.ps1 一致）
        $proxyPort = 7789
        $parsedProxyPort = 0
        if ([int]::TryParse([string]$env:PORT, [ref]$parsedProxyPort) -and $parsedProxyPort -gt 0) {
            $proxyPort = $parsedProxyPort
        }
        if (Test-PortBusy -ListenPort $proxyPort) {
            Write-LogLine ('跳过 TLS 证书生成：本机服务已在监听 {0}，此时切 HTTPS 会让它的 /sync/api 变 502' -f $proxyPort)
            Write-LogLine '  要切 HTTPS：先 .\local-server\stop.ps1，再 node sync-server\gen-cert.mjs，然后两个服务都重启'
        } elseif ($nodeForCert -and (Test-Path -LiteralPath $genScript)) {
            $opensslPath = Resolve-OpenSsl
            if (-not $opensslPath) {
                Write-LogLine '未找到 TLS 证书，也没有可用的 openssl，跳过自动生成（本次退回 HTTP）'
                Write-LogLine '  装 Git for Windows（自带 openssl）或把 openssl.exe 的目录加进 PATH，再跑 node sync-server\gen-cert.mjs'
            } else {
                $opensslDir = Split-Path -Parent $opensslPath
                if (($env:PATH -split ';') -notcontains $opensslDir) {
                    $env:PATH = $opensslDir + ';' + $env:PATH
                    Write-LogLine ('openssl 不在 PATH 里，本次临时使用：{0}' -f $opensslPath)
                }
                Write-LogLine '未找到 TLS 证书，尝试生成一次（需要 openssl）'
                # 生成器的输出不能直接并进本进程的流：Windows PowerShell 5.1 下
                # $ErrorActionPreference='Stop' 会把原生命令的 stderr 升成 NativeCommandError，
                # 直接终止整个脚本（2026-11-20 14:21:27 的开机自启就死在这一行，7788 因此没起来）。
                # 改成重定向到临时文件再逐行抄进日志：5.1 与 7 都不抛，退出码照样拿得到。
                $genOutFile = [System.IO.Path]::GetTempFileName()
                $genErrFile = [System.IO.Path]::GetTempFileName()
                $genExit = $null
                try {
                    $genArgs = @{
                        FilePath = $nodeForCert.Source
                        ArgumentList = @(('"' + $genScript + '"'))
                        WorkingDirectory = $ServerDir
                        WindowStyle = 'Hidden'
                        Wait = $true
                        PassThru = $true
                        RedirectStandardOutput = $genOutFile
                        RedirectStandardError = $genErrFile
                    }
                    $genProc = Start-Process @genArgs
                    $genExit = $genProc.ExitCode
                } catch {
                    Write-LogLine ('失败：调用 gen-cert.mjs 出错：' + $_.Exception.Message)
                }
                foreach ($genFile in @($genOutFile, $genErrFile)) {
                    if (Test-Path -LiteralPath $genFile) {
                        foreach ($genLine in (Get-Content -LiteralPath $genFile -Encoding UTF8)) {
                            if ($genLine) { Write-LogLine ([string]$genLine) }
                        }
                    }
                }
                Remove-Item -LiteralPath $genOutFile, $genErrFile -Force -ErrorAction SilentlyContinue
                if ($null -ne $genExit -and $genExit -ne 0) {
                    Write-LogLine ('证书生成失败（退出码 {0}），本次退回 HTTP' -f $genExit)
                }
            }
        }
    }
}
$UseTls = (Test-Path -LiteralPath $TlsCert) -and (Test-Path -LiteralPath $TlsKey)
$Scheme = if ($UseTls) { 'https' } else { 'http' }
if ($UseTls) {
    Write-LogLine ('HTTPS 已启用：{0}' -f $TlsCert)
    # 下面两行是历史写法，实际不影响任何东西：脚本块回调在 TLS 线程上跑不了（详见 Get-Health 注释）。
    # 真正让自签 HTTPS 探得通的是 Get-Health 里对 $UseTls 分支用 curl -k。留着只为不改动无关行。
    try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    } catch { }
} else {
    Write-LogLine '警告：没有可用 TLS 证书，退回 HTTP（/api/health 的 certFingerprint 为 null）'
}

Write-LogLine ('=== start.ps1 开始（端口 {0}）===' -f $Port)

$health = $null
if (Test-PortBusy -ListenPort $Port) { $health = Get-Health -ListenPort $Port }
if ($health -and $health.format -eq $SyncFormat) {
    Write-LogLine ('已在运行：{0}://127.0.0.1:{1}/api/health （format={2}，记录 {3} 条，会话 {4} 个）' -f $Scheme, $Port, $health.format, $health.records, $health.sessions)
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

Write-LogLine ('启动：{0} {1} --port {2}（{3}）' -f $nodePath, $serverScript, $Port, $Scheme)
Write-LogLine ('工作目录 {0}，隐藏窗口；不带 -Redirect（见文件头：避免长驻 node 占住自启的 stderr 文件）' -f $ServerDir)

$argList = @(('"' + $serverScript + '"'), '--port', [string]$Port)
if ($UseTls) {
    $argList += @('--tls-cert', ('"' + $TlsCert + '"'), '--tls-key', ('"' + $TlsKey + '"'))
}

try {
    $proc = Start-Process -FilePath $nodePath -ArgumentList $argList `
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

Write-LogLine ('就绪：{0}://127.0.0.1:{1}/api/health （PID {2}，format={3}，记录 {4} 条，会话 {5} 个）' -f $Scheme, $Port, $proc.Id, $health.format, $health.records, $health.sessions)
Write-LogLine '页面侧：浏览器打开 http://127.0.0.1:7789 后，同步地址留空即经 /sync/api 用本服务'
# 上游是 http 时没有 CA 可配，别把 tls\cert.pem 这个不存在的路径塞给 local-server
if ($UseTls) {
    Write-LogLine ('本机服务反代：设置 SYNC_UPSTREAM={0}://127.0.0.1:{1} 并配 SYNC_CA_FILE={2}' -f $Scheme, $Port, $TlsCert)
} else {
    Write-LogLine ('本机服务反代：SYNC_UPSTREAM={0}://127.0.0.1:{1}（http，无需 SYNC_CA_FILE）' -f $Scheme, $Port)
}
Write-LogLine '停止：.\sync-server\stop.ps1'
Write-LogLine '=== start.ps1 结束（成功）==='
exit 0
