$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Set-Location -LiteralPath $projectRoot
. (Join-Path $projectRoot 'scripts\tms-paths.ps1')
$dataRoot = Join-Path $libraryRoot '.tms-data'
$backendExe = Join-Path $projectRoot 'backend\target\debug\tms-server.exe'
$frontendLog = Join-Path $dataRoot 'tms-frontend.log'
$backendLog = Join-Path $dataRoot 'tms-backend.log'
$supervisorScript = Join-Path $projectRoot 'scripts\supervise-tms.ps1'

. (Join-Path $projectRoot 'scripts\tms-processes.ps1')

Import-Module ScheduledTasks -ErrorAction SilentlyContinue
foreach ($taskName in @('TMS Server Startup', 'TMS Server Startup User')) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Write-Host "Stopped scheduled task $taskName."
    }
}

$supervisorPids = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ieq 'powershell.exe' -and [string]$_.CommandLine -like "*$supervisorScript*"
} | ForEach-Object { [int]$_.ProcessId })
if ($supervisorPids.Count -gt 0) {
    Write-Host "Stopping TMS supervisor processes: $($supervisorPids -join ', ')"
    Stop-Process -Id $supervisorPids -Force -ErrorAction SilentlyContinue
}

$stopped = Stop-TmsProcesses -ProjectRoot $projectRoot -BackendExe $backendExe `
    -FrontendLog $frontendLog -BackendLog $backendLog -DataRoot $dataRoot -Component 'all' -Label 'verified TMS'
if ($stopped -eq 0 -and $supervisorPids.Count -eq 0) {
    Write-Host 'No TMS frontend, backend, or TMS-owned FFmpeg processes were found.'
}

$tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path -LiteralPath $tailscaleExe) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $tailscaleExe serve --http 3000 off 2>$null
    $tailscaleExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($tailscaleExitCode -eq 0) {
        Write-Host 'Disabled the TMS Tailscale Serve route.'
    }
}

Start-Sleep -Milliseconds 400
$remaining = @(3000, 8787) | Where-Object { Test-TmsPortListening -Port $_ } | ForEach-Object { [pscustomobject]@{ LocalPort = $_ } }
if ($remaining) {
    Write-Warning "A listener remains on port(s): $($remaining.LocalPort -join ', '). Check its owner before stopping it."
} else {
    Write-Host 'TMS is stopped: no listeners remain on ports 3000 or 8787.'
}

$global:LASTEXITCODE = 0
