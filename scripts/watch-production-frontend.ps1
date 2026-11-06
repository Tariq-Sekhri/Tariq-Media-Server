param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [Parameter(Mandatory = $true)]
    [string]$LogPath,
    [int]$Port = 3000,
    [string]$BindAddress = '0.0.0.0'
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
. (Join-Path $PSScriptRoot 'tms-ports.ps1')
Hide-TmsConsoleWindow
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$publisher = Join-Path $ProjectRoot 'scripts\publish-production-frontend.ps1'
$serverLauncher = Join-Path $ProjectRoot 'scripts\start-production-frontend.ps1'
$dataRoot = Split-Path -Parent $LogPath
$serverLogPath = Join-Path $dataRoot 'tms-frontend.log'

# The production server keeps its stdout/stderr handle open for its entire
# lifetime. It must never share the watcher log, otherwise Windows prevents
# the watcher from recording the next change or recovery error.
try {
    $watcherLock = [IO.File]::Open((Join-Path $dataRoot 'frontend-watcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    exit 0
}

function Write-FrontendWatcherLog {
    param([string]$Message)

    # A short retry handles antivirus/indexing reads without letting a log
    # handle failure stop or spam the rebuild loop.
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            Add-Content -LiteralPath $LogPath -Encoding utf8 -Value "[$(Get-Date -Format o)] $Message" -ErrorAction Stop
            return
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
}

# This keeps the app in production mode while preserving the save-and-refresh
# workflow: source changes are bundled, then only the frontend is restarted.
$watchPaths = @(
    (Join-Path $ProjectRoot 'app'),
    (Join-Path $ProjectRoot 'public'),
    (Join-Path $ProjectRoot 'next.config.ts'),
    (Join-Path $ProjectRoot 'vite.config.ts'),
    (Join-Path $ProjectRoot 'package-lock.json'),
    (Join-Path $ProjectRoot 'package.json')
) | Where-Object { Test-Path -LiteralPath $_ }

$watchers = [System.Collections.Generic.List[System.IO.FileSystemWatcher]]::new()
$changed = [System.Threading.AutoResetEvent]::new($false)
$handler = {
    $event.MessageData.changed.Set() | Out-Null
}

foreach ($watchPath in $watchPaths) {
    $item = Get-Item -LiteralPath $watchPath
    $watcherDirectory = if ($item.PSIsContainer) { $item.FullName } else { $item.DirectoryName }
    $watcherFilter = if ($item.PSIsContainer) { '*.*' } else { $item.Name }
    $watcher = [System.IO.FileSystemWatcher]::new($watcherDirectory, $watcherFilter)
    $watcher.IncludeSubdirectories = $item.PSIsContainer
    $watcher.NotifyFilter = [IO.NotifyFilters]'FileName, LastWrite, Size, DirectoryName'
    $watcher.EnableRaisingEvents = $true
    $watchers.Add($watcher)
    $messageData = @{ changed = $changed }
    Register-ObjectEvent -InputObject $watcher -EventName Changed -MessageData $messageData -Action $handler | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName Created -MessageData $messageData -Action $handler | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName Deleted -MessageData $messageData -Action $handler | Out-Null
    Register-ObjectEvent -InputObject $watcher -EventName Renamed -MessageData $messageData -Action $handler | Out-Null
}

try {
    Write-FrontendWatcherLog 'Production frontend watcher started.'
    . (Join-Path $PSScriptRoot 'frontend-source-stamp.ps1')
    $latestRelease = Get-ChildItem -LiteralPath (Join-Path $dataRoot 'frontend-releases') -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Where-Object {
            (Test-Path (Join-Path $_.FullName 'dist\client\index.html')) -and
            (Test-Path (Join-Path $_.FullName 'dist\server\index.js')) -and
            (Test-Path (Join-Path $_.FullName 'dist\server\ssr\index.js'))
        } | Select-Object -First 1
    if ($latestRelease) {
        $stampFile = Join-Path $latestRelease.FullName 'source-stamp.txt'
        if ((Test-Path $stampFile) -and ([IO.File]::ReadAllText($stampFile) -ne (Get-TmsFrontendSourceStamp -ProjectRoot $ProjectRoot))) {
            Write-FrontendWatcherLog 'Source changed while watcher was stopped; rebuild queued.'
            $changed.Set() | Out-Null
        } elseif (!(Test-Path $stampFile)) {
            $newestSource = $watchPaths | ForEach-Object { Get-ChildItem -LiteralPath $_ -File -Recurse } |
                Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
            if ($newestSource.LastWriteTimeUtc -gt $latestRelease.CreationTimeUtc) {
                $changed.Set() | Out-Null
            } else {
                [IO.File]::WriteAllText($stampFile, (Get-TmsFrontendSourceStamp -ProjectRoot $ProjectRoot))
            }
        }
        try {
            $liveRelease = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/tms-release" -TimeoutSec 5
            if ($liveRelease.release -ne $latestRelease.Name) {
                Write-FrontendWatcherLog "Live release $($liveRelease.release) differs from $($latestRelease.Name); recovery queued."
                $changed.Set() | Out-Null
            }
        } catch {
            Write-FrontendWatcherLog 'Live release could not be checked; recovery queued.'
            $changed.Set() | Out-Null
        }
    }
    while ($true) {
        if (!$changed.WaitOne(1000)) { continue }
        do { Start-Sleep -Milliseconds 700 } while ($changed.WaitOne(100))

        Write-FrontendWatcherLog 'Source change detected; rebuilding production frontend.'
        Push-Location $ProjectRoot
        try {
            & npm.cmd run build *>> $LogPath
            if ($LASTEXITCODE -ne 0) {
                Write-FrontendWatcherLog 'Rebuild failed; keeping the current frontend running.'
                continue
            }

        # Build output is staged before the live process is touched.  The
        # previous watcher rebuilt directly under a running Vinext server,
        # causing its old HTML to reference assets that the build had deleted.
        $releaseRoot = & $publisher -ProjectRoot $ProjectRoot
        if ($LASTEXITCODE -ne 0 -or !$releaseRoot) {
            throw 'Could not stage the completed frontend build as an immutable release.'
        }
        $releaseRoot = ([string]$releaseRoot | Select-Object -Last 1).Trim()

        # Stop only the process that owns the public frontend port. Do not use
        # the broader TMS process-tree helper here: this watcher may share a
        # launcher ancestor with the server it is replacing.
        foreach ($ownerId in @(Get-TmsPortOwnerIds -Port $Port)) {
            Stop-Process -Id $ownerId -Force -ErrorAction Stop
        }
        $releaseDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while (Test-TmsPortListening -Port $Port) {
            if ([DateTime]::UtcNow -ge $releaseDeadline) {
                throw "Frontend port $Port did not release after restart request."
            }
            Start-Sleep -Milliseconds 200
        }
            [void](Start-TmsHiddenProcess -FilePath 'powershell.exe' `
                -Arguments "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serverLauncher`" -ProjectRoot `"$ProjectRoot`" -ReleaseRoot `"$releaseRoot`" -LogPath `"$serverLogPath`" -Port $Port -BindAddress $BindAddress" `
                -WorkingDirectory $ProjectRoot `
                -LogPath ($serverLogPath + '.launcher.log'))
            $serverDeadline = [DateTime]::UtcNow.AddSeconds(60)
            $expectedRelease = Split-Path -Leaf $releaseRoot
            $liveReleaseId = ''
            do {
                try {
                    $liveReleaseId = (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/tms-release" -TimeoutSec 2).release
                } catch { $liveReleaseId = '' }
                if ($liveReleaseId -eq $expectedRelease) { break }
                Start-Sleep -Milliseconds 250
            } while ([DateTime]::UtcNow -lt $serverDeadline)
            if ($liveReleaseId -ne $expectedRelease) {
                throw "Frontend activation failed: expected $expectedRelease on port $Port, received '$liveReleaseId'."
            }
            Write-FrontendWatcherLog "Production frontend restarted and verified: $expectedRelease."
        } catch {
            Write-FrontendWatcherLog "Production frontend watcher error: $($_.Exception.Message)"
        } finally {
            Pop-Location
        }
    }
} finally {
    $watcherLock.Dispose()
}
