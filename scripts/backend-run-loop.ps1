$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendDir = Join-Path $projectRoot 'backend'
. (Join-Path $projectRoot 'scripts\tms-paths.ps1')
$env:TMS_LIBRARY_ROOT = $libraryRoot
$runtimeDir = Join-Path $dataRoot 'backend-runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
try { $controllerLock = [IO.File]::Open((Join-Path $dataRoot 'backend-controller.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { exit 0 }
$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$compiledExe = Join-Path $backendDir 'target\debug\tms-server.exe'
$runtimeExe = Join-Path $runtimeDir 'tms-server.exe'
$buildLog = Join-Path $dataRoot 'tms-backend-build.log'
$serverLog = Join-Path $dataRoot 'tms-backend.log'
$controllerLog = Join-Path $dataRoot 'tms-backend-controller.log'
function Write-ControllerLog([string]$Message) {
    try { Add-Content $controllerLog "[$(Get-Date -Format o)] $Message" -Encoding utf8 -ErrorAction Stop } catch { }
}
function Stop-BackendProcessTree {
    if ($server -and !$server.HasExited) {
        # Forced termination skips Rust's child cleanup. Stop this backend's
        # descendants too so orphan FFmpeg jobs cannot overwrite an HLS cache.
        & taskkill.exe /PID $server.Id /T /F | Out-Null
        $server.WaitForExit()
    }
}
function Get-SourceStamp {
    $files = @(Get-ChildItem (Join-Path $backendDir 'src') -File -Recurse)
    $files += @(Get-Item (Join-Path $backendDir 'Cargo.toml'), (Join-Path $backendDir 'Cargo.lock'))
    return (($files | Sort-Object FullName | ForEach-Object { "$($_.FullName):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }) -join '|')
}
$server = $null
$stampFile = Join-Path $runtimeDir 'source-stamp.txt'
$builtStamp = if (Test-Path $stampFile) { Get-Content $stampFile -Raw } else { '' }
if (!(Test-Path $runtimeExe) -and (Test-Path $compiledExe)) {
    Copy-Item $compiledExe $runtimeExe
}
if (!$builtStamp -and (Test-Path $runtimeExe)) {
    $newestSource = @(Get-ChildItem (Join-Path $backendDir 'src') -File -Recurse) + @(Get-Item (Join-Path $backendDir 'Cargo.toml'), (Join-Path $backendDir 'Cargo.lock')) |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ((Get-Item $runtimeExe).LastWriteTimeUtc -ge $newestSource.LastWriteTimeUtc) {
        $builtStamp = Get-SourceStamp
        [IO.File]::WriteAllText($stampFile, $builtStamp)
    }
}
$retryAt = [DateTime]::MinValue
try {
    while ($true) {
        if ((!$server -or $server.HasExited) -and (Test-Path $runtimeExe)) {
            $server = Start-Process -FilePath $runtimeExe -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput $serverLog -RedirectStandardError ($serverLog + '.stderr.log')
            Write-ControllerLog "Existing backend runtime started immediately (PID $($server.Id))."
        }
        $stamp = Get-SourceStamp
        if ($stamp -ne $builtStamp -and [DateTime]::UtcNow -ge $retryAt) {
            Write-ControllerLog 'Building backend; existing runtime remains available.'
            $result = Start-TmsHiddenProcess -FilePath $cargo -Arguments 'build' -WorkingDirectory $backendDir -LogPath $buildLog -Wait
            if ($result -eq 0) {
                Stop-BackendProcessTree
                Copy-Item $compiledExe $runtimeExe -Force
                $builtStamp = $stamp
                [IO.File]::WriteAllText($stampFile, $builtStamp)
                Write-ControllerLog 'Backend build published.'
            } else {
                Write-ControllerLog "Build failed ($result); retaining last successful runtime and retrying in 60 seconds."
                $retryAt = [DateTime]::UtcNow.AddSeconds(60)
            }
        }
        if ((!$server -or $server.HasExited) -and (Test-Path $runtimeExe)) {
            $server = Start-Process -FilePath $runtimeExe -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput $serverLog -RedirectStandardError ($serverLog + '.stderr.log')
            Write-ControllerLog "Backend started (PID $($server.Id))."
        }
        Start-Sleep -Seconds 2
    }
} finally {
    Stop-BackendProcessTree
    $controllerLock.Dispose()
}
