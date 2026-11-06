$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stopScript = Join-Path $projectRoot 'kill_tms.ps1'
$startupTaskNames = @('TMS Server Startup', 'TMS Server Startup User')

& $stopScript

foreach ($startupTaskName in $startupTaskNames) {
    if (Get-ScheduledTask -TaskName $startupTaskName -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName $startupTaskName
        Write-Host "Requested a TMS server restart through the startup task ($startupTaskName)."
        exit 0
    }
}

& (Join-Path $projectRoot 'start_tms.ps1')
