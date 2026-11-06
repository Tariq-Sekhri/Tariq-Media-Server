param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [Parameter(Mandatory = $true)] [string]$ReleaseRoot,
    [Parameter(Mandatory = $true)] [string]$LogPath,
    [int]$Port = 3000,
    [string]$BindAddress = '0.0.0.0'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
Hide-TmsConsoleWindow
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$ReleaseRoot = (Resolve-Path -LiteralPath $ReleaseRoot).Path
if (!(Test-Path -LiteralPath (Join-Path $ReleaseRoot 'dist\client\index.html')) -or !(Test-Path -LiteralPath (Join-Path $ReleaseRoot 'dist\server\index.js')) -or !(Test-Path -LiteralPath (Join-Path $ReleaseRoot 'dist\server\ssr\index.js'))) {
    throw "The requested frontend release is incomplete: $ReleaseRoot"
}

# Releases live outside the checkout. External SSR imports still need the
# installed dependencies in the release's Node module resolution ancestry.
$releaseDependencies = Join-Path $ReleaseRoot 'node_modules'
if (!(Test-Path -LiteralPath $releaseDependencies)) {
    New-Item -ItemType Junction -Path $releaseDependencies -Target (Join-Path $ProjectRoot 'node_modules') | Out-Null
}

$env:TMS_FRONTEND_RELEASE_ROOT = $ReleaseRoot
$env:TMS_FRONTEND_RELEASE_ID = Split-Path -Leaf $ReleaseRoot
$env:TMS_FRONTEND_PORT = [string]$Port
$env:TMS_FRONTEND_BIND_ADDRESS = $BindAddress
$node = (Get-Command node.exe -ErrorAction Stop).Source
# The previous release can still have tms-frontend.log open while this
# launcher is replacing it.  Use a fresh runtime log so a locked old log never
# prevents the replacement server from starting.
exit (Start-TmsHiddenProcess -FilePath $node -Arguments ('"' + (Join-Path $ProjectRoot 'scripts\serve-production-frontend.mjs') + '"') -WorkingDirectory $ProjectRoot -LogPath ($LogPath + '.runtime.log') -Wait)
