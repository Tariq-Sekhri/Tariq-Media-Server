. (Join-Path $PSScriptRoot 'tms-ports.ps1')

function Test-TmsRelatedProcess {
    param(
        [Parameter(Mandatory = $true)]
        $Process,
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory = $true)]
        [string]$BackendExe,
        [string]$FrontendLog,
        [string]$BackendLog,
        [string]$DataRoot
    )

    $commandLine = [string]$Process.CommandLine
    if ($commandLine -like '*supervise-tms.ps1*') {
        return $false
    }

    if ($Process.ExecutablePath -and $Process.ExecutablePath -ieq $BackendExe) {
        return $true
    }

    if (!$commandLine) {
        return $false
    }

    if ($FrontendLog -and $commandLine -like "*$FrontendLog*") {
        return $true
    }
    if ($BackendLog -and $commandLine -like "*$BackendLog*") {
        return $true
    }
    if ($commandLine -like "*$ProjectRoot*") {
        return $true
    }
    if ($Process.Name -ieq 'powershell.exe' -and $commandLine -like '*backend-dev.ps1*') {
        return $true
    }
    if ($Process.Name -ieq 'cargo-watch.exe') {
        return $true
    }

    return $false
}

function Test-TmsBackendProcess {
    param(
        [Parameter(Mandatory = $true)]
        $Process,
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory = $true)]
        [string]$BackendExe,
        [Parameter(Mandatory = $true)]
        [string]$BackendLog,
        [string]$DataRoot
    )

    if ($Process.ExecutablePath -and $Process.ExecutablePath -ieq $BackendExe) {
        return $true
    }
    if ($Process.Name -ieq 'tms-server.exe') {
        return $true
    }
    if ($Process.Name -ieq 'cargo-watch.exe') {
        return $true
    }

    $commandLine = [string]$Process.CommandLine
    if (!$commandLine) {
        return $false
    }

    if ($BackendLog -and $commandLine -like "*$BackendLog*") {
        return $true
    }
    if ($Process.Name -ieq 'powershell.exe' -and $commandLine -like '*backend-dev.ps1*') {
        return $true
    }
    if ($Process.Name -ieq 'cmd.exe' -and $commandLine -like '*backend:dev*') {
        return $true
    }
    if ($Process.Name -ieq 'powershell.exe' -and $commandLine -like '*backend-run-loop.ps1*') {
        return $true
    }
    if ($Process.Name -ieq 'cargo.exe' -and (
            $commandLine -like '*backend\Cargo.toml*' -or
            $commandLine -like '*backend/Cargo.toml*'
        )) {
        return $true
    }

    return $false
}

function Test-TmsFrontendProcess {
    param(
        [Parameter(Mandatory = $true)]
        $Process,
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory = $true)]
        [string]$BackendExe,
        [Parameter(Mandatory = $true)]
        [string]$FrontendLog
    )

    if ($Process.ExecutablePath -and $Process.ExecutablePath -ieq $BackendExe) {
        return $false
    }
    if ($Process.Name -ieq 'tms-server.exe') {
        return $false
    }

    $commandLine = [string]$Process.CommandLine
    if ($Process.Name -ieq 'powershell.exe' -and $commandLine -like '*backend-dev.ps1*') {
        return $false
    }
    if ($Process.Name -ieq 'powershell.exe' -and $commandLine -like '*start-production-frontend.ps1*') {
        return $true
    }
    if ($Process.Name -ieq 'powershell.exe' -and $commandLine -like '*watch-production-frontend.ps1*') {
        return $true
    }
    if ($Process.Name -ieq 'node.exe' -and $commandLine -like '*serve-production-frontend.mjs*') {
        return $true
    }
    if ($Process.Name -ieq 'cargo.exe' -and $commandLine -like '*backend/Cargo.toml*') {
        return $false
    }

    if ($FrontendLog -and $commandLine -like "*$FrontendLog*") {
        return $true
    }
    if ($commandLine -like "*$ProjectRoot*" -and (
            $commandLine -like '*vinext*' -or
            $commandLine -like '*npm run dev*' -or
            $commandLine -like '*npm-cli.js* dev*'
        )) {
        return $true
    }

    return $false
}

function Expand-ProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.HashSet[int]]$SeedPids,
        [Parameter(Mandatory = $true)]
        [array]$Processes
    )

    if ($SeedPids.Count -gt 0) {
        do {
            $added = $false
            foreach ($process in $Processes) {
                if ($process.Name -ieq 'yt-dlp.exe' -or $process.Name -ieq 'ffmpeg.exe') {
                    continue
                }
                if ($SeedPids.Contains([int]$process.ParentProcessId)) {
                    $added = $SeedPids.Add([int]$process.ProcessId) -or $added
                }
            }
        } while ($added)
    }

    return $SeedPids
}

function Get-TmsProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory = $true)]
        [string]$BackendExe,
        [Parameter(Mandatory = $true)]
        [string]$FrontendLog,
        [Parameter(Mandatory = $true)]
        [string]$BackendLog,
        [Parameter(Mandatory = $true)]
        [string]$DataRoot,
        [ValidateSet('all', 'frontend', 'backend')]
        [string]$Component = 'all'
    )

    $processes = @(Get-CimInstance Win32_Process)
    $tmsPids = [System.Collections.Generic.HashSet[int]]::new()
    # Never classify the caller or its parents from script/log names embedded
    # in their command line (for example a recovery command running this helper).
    $callerPids = [System.Collections.Generic.HashSet[int]]::new()
    $callerId = $PID
    while ($callerId -gt 0 -and $callerPids.Add($callerId)) {
        $callerProcess = $processes | Where-Object ProcessId -eq $callerId | Select-Object -First 1
        if (!$callerProcess) { break }
        $callerId = [int]$callerProcess.ParentProcessId
    }

    foreach ($process in $processes) {
        if ($callerPids.Contains([int]$process.ProcessId)) { continue }
        $isMatch = switch ($Component) {
            'frontend' {
                Test-TmsFrontendProcess -Process $process -ProjectRoot $ProjectRoot -BackendExe $BackendExe -FrontendLog $FrontendLog
            }
            'backend' {
                Test-TmsBackendProcess -Process $process -ProjectRoot $ProjectRoot -BackendExe $BackendExe -BackendLog $BackendLog -DataRoot $DataRoot
            }
            default {
                Test-TmsRelatedProcess -Process $process -ProjectRoot $ProjectRoot -BackendExe $BackendExe `
                    -FrontendLog $FrontendLog -BackendLog $BackendLog -DataRoot $DataRoot
            }
        }
        if ($isMatch) {
            [void]$tmsPids.Add([int]$process.ProcessId)
        }
    }

    if ($tmsPids.Count -gt 0) {
        [void](Expand-ProcessTree -SeedPids $tmsPids -Processes $processes)
    }

    $port = switch ($Component) {
        'frontend' { 3000 }
        'backend' { 8787 }
        default { $null }
    }
    $ports = if ($port) { @($port) } else { @(3000, 8787) }

    foreach ($listenPort in $ports) {
        $ownerIds = @(Get-TmsPortOwnerIds -Port $listenPort)
        foreach ($ownerIdValue in $ownerIds) {
            $ownerId = [int]$ownerIdValue
            if ($ownerId -le 0) {
                continue
            }
            # Windows can withhold the command line for a long-running Node
            # process launched by a scheduled task.  Port 3000 is reserved for
            # this frontend, so it remains the reliable identity when its
            # process metadata is unavailable.
            if ($Component -eq 'frontend') {
                [void]$tmsPids.Add($ownerId)
                continue
            }
            $owner = $processes | Where-Object ProcessId -eq $ownerId | Select-Object -First 1
            if (!$owner) {
                continue
            }
            $isMatch = switch ($Component) {
                'frontend' {
                    Test-TmsFrontendProcess -Process $owner -ProjectRoot $ProjectRoot -BackendExe $BackendExe -FrontendLog $FrontendLog
                }
                'backend' {
                    Test-TmsBackendProcess -Process $owner -ProjectRoot $ProjectRoot -BackendExe $BackendExe -BackendLog $BackendLog -DataRoot $DataRoot
                }
                default {
                    Test-TmsRelatedProcess -Process $owner -ProjectRoot $ProjectRoot -BackendExe $BackendExe `
                        -FrontendLog $FrontendLog -BackendLog $BackendLog -DataRoot $DataRoot
                }
            }
            if ($isMatch) {
                [void]$tmsPids.Add($ownerId)
            }
        }
    }

    if ($tmsPids.Count -gt 0) {
        [void](Expand-ProcessTree -SeedPids $tmsPids -Processes $processes)
    }

    foreach ($callerId in $callerPids) { [void]$tmsPids.Remove($callerId) }
    return $tmsPids
}

function Stop-TmsProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory = $true)]
        [string]$BackendExe,
        [Parameter(Mandatory = $true)]
        [string]$FrontendLog,
        [Parameter(Mandatory = $true)]
        [string]$BackendLog,
        [Parameter(Mandatory = $true)]
        [string]$DataRoot,
        [ValidateSet('all', 'frontend', 'backend')]
        [string]$Component = 'all',
        [string]$Label = 'TMS'
    )

    $tmsPids = Get-TmsProcessIds -ProjectRoot $ProjectRoot -BackendExe $BackendExe `
        -FrontendLog $FrontendLog -BackendLog $BackendLog -DataRoot $DataRoot -Component $Component
    if ($tmsPids.Count -eq 0) {
        return 0
    }

    $ids = @($tmsPids | Sort-Object -Descending)
    Write-Host "Stopping $Label processes: $($ids -join ', ')"
    Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue

    # TMS also starts at boot as SYSTEM. Those processes survive Stop-Process when
    # this shell is not elevated, so report what is still running instead of
    # letting the caller assume the port and the build directory were released.
    $survivors = @(Wait-TmsProcessesStopped -Ids $ids)
    if ($survivors.Count -gt 0) {
        Write-Warning "Could not stop $Label processes: $($survivors -join ', '). Administrator rights are usually required."
    }
    return $ids.Count
}

function Wait-TmsProcessesStopped {
    param(
        [int[]]$Ids = @(),
        [int]$TimeoutMs = 5000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ($true) {
        $alive = @($Ids | Where-Object { $_ -gt 0 -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
        if ($alive.Count -eq 0 -or [DateTime]::UtcNow -ge $deadline) {
            return $alive
        }
        Start-Sleep -Milliseconds 200
    }
}
