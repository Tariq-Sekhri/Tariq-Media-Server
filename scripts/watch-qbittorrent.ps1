[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$QbittorrentPath,

    [ValidateRange(1, 65535)]
    [int]$WebUiPort = 8181,

    [Parameter(Mandatory = $true)]
    [string]$LogPath
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
Hide-TmsConsoleWindow
$pollSeconds = 2
$unhealthyRestartSeconds = 12
$launchGraceSeconds = 15
$lastLaunch = [datetime]::MinValue
$unhealthySince = $null

function Write-WatchdogLog {
    param([string]$Message)

    try {
        $parent = Split-Path -Parent $LogPath
        if ($parent) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 1MB) {
            Move-Item -LiteralPath $LogPath -Destination "$LogPath.previous" -Force
        }
        Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) $Message"
    } catch {
        # Logging must never take the watchdog down.
    }
}

function Get-QbittorrentProcesses {
    return @(Get-Process -Name 'qbittorrent' -ErrorAction SilentlyContinue)
}

function Test-QbittorrentWebUi {
    # Windows listener snapshots can temporarily omit a live socket or report
    # PID 0. Probe qBittorrent itself before restarting an otherwise healthy app.
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$WebUiPort/api/v2/app/version" `
            -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return $response.StatusCode -eq 200 -and $response.Content.Trim() -match '^v?\d+\.\d+'
    } catch {
        # An authenticated Web UI still proves the server is responding.
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        return $status -in @(401, 403)
    }
}

function Start-Qbittorrent {
    if (!(Test-Path -LiteralPath $QbittorrentPath -PathType Leaf)) {
        Write-WatchdogLog "qBittorrent executable is missing: $QbittorrentPath"
        return
    }

    try {
        $processId = Start-TmsHiddenProcess -FilePath $QbittorrentPath -Arguments '--no-splash'
        $script:lastLaunch = Get-Date
        Write-WatchdogLog "Started qBittorrent (PID $processId)."
    } catch {
        Write-WatchdogLog "Failed to start qBittorrent: $($_.Exception.Message)"
    }
}

Write-WatchdogLog "Watchdog started for Web UI port $WebUiPort."

while ($true) {
    try {
        if (Test-QbittorrentWebUi) {
            if ($null -ne $unhealthySince) {
                Write-WatchdogLog 'qBittorrent Web UI is healthy again.'
            }
            $unhealthySince = $null
            Start-Sleep -Seconds $pollSeconds
            continue
        }

        $processes = Get-QbittorrentProcesses
        if ($processes.Count -eq 0) {
            $unhealthySince = $null
            if (((Get-Date) - $lastLaunch).TotalSeconds -ge $launchGraceSeconds) {
                Write-WatchdogLog 'qBittorrent is not running; starting it.'
                Start-Qbittorrent
            }
            Start-Sleep -Seconds $pollSeconds
            continue
        }

        if ($null -eq $unhealthySince) {
            $unhealthySince = Get-Date
            Write-WatchdogLog 'qBittorrent is running but its Web UI is not listening; recovery timer started.'
        } elseif (((Get-Date) - $unhealthySince).TotalSeconds -ge $unhealthyRestartSeconds -and
            ((Get-Date) - $lastLaunch).TotalSeconds -ge $launchGraceSeconds) {
            $processIds = ($processes | Select-Object -ExpandProperty Id) -join ', '
            Write-WatchdogLog "Web UI stayed unavailable; restarting qBittorrent process(es): $processIds."
            $processes | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 750
            Start-Qbittorrent
            $unhealthySince = $null
        }
    } catch {
        Write-WatchdogLog "Watchdog loop error: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $pollSeconds
}
