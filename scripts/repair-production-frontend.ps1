param([int]$Port = 3000)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'tms-paths.ps1')
. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
. (Join-Path $PSScriptRoot 'frontend-source-stamp.ps1')
$repairLog = Join-Path $dataRoot 'frontend-repair.log'

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to replace the protected frontend process.'
    }
    $release = Get-ChildItem (Join-Path $dataRoot 'frontend-releases') -Directory |
        Sort-Object Name -Descending | Where-Object {
            (Test-Path (Join-Path $_.FullName 'dist\server\index.js')) -and
            (Test-Path (Join-Path $_.FullName 'dist\server\ssr\index.js')) -and
            (Test-Path (Join-Path $_.FullName 'dist\client\index.html')) -and
            (Test-Path (Join-Path $_.FullName 'source-stamp.txt'))
        } | Select-Object -First 1
    if (!$release) { throw 'No complete published frontend release exists.' }
    if ([IO.File]::ReadAllText((Join-Path $release.FullName 'source-stamp.txt')) -ne (Get-TmsFrontendSourceStamp -ProjectRoot $projectRoot)) {
        throw 'The latest frontend release does not match the checkout; wait for the build to finish.'
    }
    Add-Content $repairLog "[$(Get-Date -Format o)] Activating $($release.Name)."
    $watcherScript = Join-Path $PSScriptRoot 'watch-production-frontend.ps1'
    Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -ieq 'powershell.exe' -and
        $_.CommandLine -like "*$watcherScript*"
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Get-TmsPortOwnerIds -Port $Port |
        ForEach-Object { Stop-Process -Id $_ -Force }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Test-TmsPortListening -Port $Port) {
        if ([DateTime]::UtcNow -gt $deadline) { throw "Port $Port did not release." }
        Start-Sleep -Milliseconds 200
    }
    $serverScript = Join-Path $PSScriptRoot 'start-production-frontend.ps1'
    $serverLog = Join-Path $dataRoot 'tms-frontend.log'
    [void](Start-TmsHiddenProcess -FilePath 'powershell.exe' -WorkingDirectory $projectRoot `
        -Arguments "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serverScript`" -ProjectRoot `"$projectRoot`" -ReleaseRoot `"$($release.FullName)`" -LogPath `"$serverLog`" -Port $Port" `
        -LogPath ($serverLog + '.launcher.log'))
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $live = ''
    do {
        try { $live = (Invoke-RestMethod "http://127.0.0.1:$Port/tms-release" -TimeoutSec 2).release } catch { $live = '' }
        if ($live -eq $release.Name) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($live -ne $release.Name) { throw "Expected $($release.Name), received '$live'." }
    Add-Content $repairLog "[$(Get-Date -Format o)] Verified live release: $live."
} catch {
    Add-Content $repairLog "[$(Get-Date -Format o)] Repair failed: $($_.Exception.Message)"
    throw
} finally {
    # Restore automatic rebuilds even if frontend activation failed.
    if ($watcherScript) {
        $watcherLog = Join-Path $dataRoot 'tms-frontend-watcher.log'
        [void](Start-TmsHiddenProcess -FilePath 'powershell.exe' -WorkingDirectory $projectRoot `
            -Arguments "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watcherScript`" -ProjectRoot `"$projectRoot`" -LogPath `"$watcherLog`" -Port $Port" `
            -LogPath ($watcherLog + '.launcher.log'))
    }
}
