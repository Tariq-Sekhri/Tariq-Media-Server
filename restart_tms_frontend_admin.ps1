#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

# One-time activation for the repaired production frontend watcher. This does
# not stop or rebuild the backend; it only replaces the system-owned listener
# on port 3000, then uses the normal production frontend launcher.
$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
. (Join-Path $projectRoot 'scripts\tms-paths.ps1')
$backendExe = Join-Path $projectRoot 'backend\target\debug\tms-server.exe'

. (Join-Path $projectRoot 'scripts\tms-processes.ps1')

[void](Stop-TmsProcesses `
    -ProjectRoot $projectRoot `
    -BackendExe $backendExe `
    -FrontendLog (Join-Path $dataRoot 'tms-frontend.log') `
    -BackendLog (Join-Path $dataRoot 'tms-backend.log') `
    -DataRoot $dataRoot `
    -Component frontend `
    -Label 'TMS frontend')

if (Test-TmsPortListening -Port 3000) {
    throw 'Port 3000 is still occupied; the frontend was not restarted.'
}

& (Join-Path $projectRoot 'start_tms.ps1') -FrontendOnly
if ($LASTEXITCODE -ne 0) {
    throw "Frontend startup failed with exit code $LASTEXITCODE."
}

$response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/manifest.webmanifest' -TimeoutSec 15
if ($response.StatusCode -ne 200) {
    throw "Frontend health check returned HTTP $($response.StatusCode)."
}

Write-Host 'TMS frontend restarted with the repaired rebuild watcher.'
