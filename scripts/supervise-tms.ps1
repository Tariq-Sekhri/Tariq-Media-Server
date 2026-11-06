param(
    [int]$CheckIntervalSeconds = 15,
    [int]$FailureThreshold = 3,
    [int]$BackendRebuildGraceSeconds = 600,
    # A normal optimized frontend rebuild takes seconds. Do not leave the app
    # offline for fifteen minutes when a watcher survives but its replacement
    # server did not start.
    [int]$FrontendRebuildGraceSeconds = 120
)

$ErrorActionPreference = 'Continue'

. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
Hide-TmsConsoleWindow

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $projectRoot 'start_tms.ps1'
. (Join-Path $projectRoot 'scripts\tms-paths.ps1')
$logPath = Join-Path $dataRoot 'tms-startup-supervisor.log'
$recoveryLog = Join-Path $dataRoot 'tms-startup-recovery.log'
$backendLog = Join-Path $dataRoot 'tms-backend.log'
$frontendWatcherScript = Join-Path $projectRoot 'scripts\watch-production-frontend.ps1'
$backendDevScript = Join-Path $projectRoot 'scripts\backend-dev.ps1'

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
# An exclusive file handle also prevents duplicate supervisors across sessions.
try {
    $supervisorLock = [IO.File]::Open((Join-Path $dataRoot 'supervisor.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch { exit 0 }

function Write-SupervisorLog {
    param([string]$Message)
    try { Add-Content -LiteralPath $logPath -Encoding utf8 -Value "[$(Get-Date -Format o)] $Message" -ErrorAction Stop } catch { }
}

function Test-TmsPort {
    param([int]$Port)
    return Test-TmsPortListening -Port $Port
}

function Test-TmsHttp {
    param([string]$Uri)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Test-CommandLineMatch {
    param(
        [string]$CommandLine,
        [string]$Needle
    )

    if (!$CommandLine -or !$Needle) {
        return $false
    }
    return $CommandLine.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-TmsBackendWatcher {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ($process.Name -ieq 'cargo-watch.exe' -and $commandLine -like "*$projectRoot*") {
            return $true
        }
        if ($process.Name -ieq 'powershell.exe' -and (Test-CommandLineMatch $commandLine $backendDevScript)) {
            return $true
        }
        if ($process.Name -ieq 'cmd.exe' -and (Test-CommandLineMatch $commandLine 'backend:dev')) {
            return $true
        }
        if (Test-CommandLineMatch $commandLine $backendLog) {
            return $true
        }
    }
    return $false
}

function Test-TmsFrontendWatcher {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        if ($process.Name -ieq 'powershell.exe' -and (Test-CommandLineMatch ([string]$process.CommandLine) $frontendWatcherScript)) {
            return $true
        }
    }
    return $false
}

Write-SupervisorLog 'TMS startup supervisor started.'

$backendFailures = 0
$frontendFailures = 0
$backendDownSince = $null
$frontendDownSince = $null
$lastHeartbeat = [DateTime]::MinValue

while ($true) {
    try {
        $frontendUp = (Test-TmsPort -Port 3000) -and (Test-TmsHttp -Uri 'http://127.0.0.1:3000/') -and (Test-TmsHttp -Uri 'http://127.0.0.1:3000/manifest.webmanifest')
        $backendUp = (Test-TmsPort -Port 8787) -and (Test-TmsHttp -Uri 'http://127.0.0.1:8787/api/health')
        $backendWatcher = Test-TmsBackendWatcher
        $frontendWatcher = Test-TmsFrontendWatcher
        $now = Get-Date

        if ($backendUp) {
            $backendFailures = 0
            $backendDownSince = $null
        } else {
            $backendFailures++
            if ($null -eq $backendDownSince) {
                $backendDownSince = $now
            }
        }

        if ($frontendUp) {
            $frontendFailures = 0
            $frontendDownSince = $null
        } else {
            $frontendFailures++
            if ($null -eq $frontendDownSince) {
                $frontendDownSince = $now
            }
        }

        if (($now - $lastHeartbeat).TotalMinutes -ge 10) {
            Write-SupervisorLog "Heartbeat (frontend=$frontendUp watcher=$frontendWatcher, backend=$backendUp watcher=$backendWatcher)."
            $lastHeartbeat = $now
        }

        $restartBackend = $false
        $restartFrontend = $false

        if (!$backendUp -and !$backendWatcher) { $backendFailures = $FailureThreshold }
        if (!$frontendUp -and !$frontendWatcher) { $frontendFailures = $FailureThreshold }

        if (!$backendUp -and $backendFailures -ge $FailureThreshold) {
            $downForSeconds = if ($backendDownSince) { ($now - $backendDownSince).TotalSeconds } else { 0 }
            if ($backendWatcher -and $downForSeconds -lt $BackendRebuildGraceSeconds) {
                if ($backendFailures -eq $FailureThreshold -or ($backendFailures % 8) -eq 0) {
                    Write-SupervisorLog "Backend unhealthy but its controller is alive (${downForSeconds}s); waiting for rebuild."
                }
            } else {
                $restartBackend = $true
            }
        }

        if (!$frontendUp -and $frontendFailures -ge $FailureThreshold) {
            $downForSeconds = if ($frontendDownSince) { ($now - $frontendDownSince).TotalSeconds } else { 0 }
            if ($frontendWatcher -and $downForSeconds -lt $FrontendRebuildGraceSeconds) {
                if ($frontendFailures -eq $FailureThreshold -or ($frontendFailures % 8) -eq 0) {
                    Write-SupervisorLog "Frontend unhealthy but rebuild watcher is alive (${downForSeconds}s); waiting for rebuild."
                }
            } else {
                $restartFrontend = $true
            }
        }

        if ($restartBackend -or $restartFrontend) {
            Write-SupervisorLog "Service recovery needed (frontendUp=$frontendUp watcher=$frontendWatcher, backendUp=$backendUp watcher=$backendWatcher)."
            try {
                if ($restartBackend -and !$restartFrontend) {
                    & $launcher -BackendOnly *>> $recoveryLog
                } elseif ($restartFrontend -and !$restartBackend) {
                    & $launcher -FrontendOnly *>> $recoveryLog
                } else {
                    # Recover independently so one failed component cannot block the other.
                    try { & $launcher -BackendOnly *>> $recoveryLog } catch { Write-SupervisorLog "Backend recovery failed: $_" }
                    & $launcher -FrontendOnly *>> $recoveryLog
                }

                $frontendUp = (Test-TmsPort -Port 3000) -and (Test-TmsHttp -Uri 'http://127.0.0.1:3000/') -and (Test-TmsHttp -Uri 'http://127.0.0.1:3000/manifest.webmanifest')
                $backendUp = (Test-TmsPort -Port 8787) -and (Test-TmsHttp -Uri 'http://127.0.0.1:8787/api/health')
                Write-SupervisorLog "Launcher finished (frontend=$frontendUp, backend=$backendUp)."

                if ($backendUp) {
                    $backendFailures = 0
                    $backendDownSince = $null
                }
                if ($frontendUp) {
                    $frontendFailures = 0
                    $frontendDownSince = $null
                }
            } catch {
                Write-SupervisorLog "Launcher failed: $($_.Exception.Message)"
                Start-Sleep -Seconds 60
            }
        }
    } catch {
        Write-SupervisorLog "Supervisor loop error: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds ([Math]::Max(5, $CheckIntervalSeconds))
}
