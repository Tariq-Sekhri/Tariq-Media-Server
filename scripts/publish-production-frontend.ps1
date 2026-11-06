param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$distPath = Join-Path $ProjectRoot 'dist'
if (!(Test-Path -LiteralPath (Join-Path $distPath 'client\index.html')) -or !(Test-Path -LiteralPath (Join-Path $distPath 'server\index.js')) -or !(Test-Path -LiteralPath (Join-Path $distPath 'server\ssr\index.js'))) {
    throw 'The frontend build is incomplete: expected the client entrypoint plus server and SSR entrypoints.'
}

# Vinext serves hashed files from the same directory as the server bundle.
# Never replace that directory beneath a running server: a build removes the
# old hashed assets before the new HTML is ready.
. (Join-Path $ProjectRoot 'scripts\tms-paths.ps1')
$releasesRoot = Join-Path $dataRoot 'frontend-releases'
New-Item -ItemType Directory -Force -Path $releasesRoot | Out-Null
$releaseName = "release-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmssfff'))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$releaseRoot = Join-Path $releasesRoot $releaseName
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
Copy-Item -LiteralPath $distPath -Destination (Join-Path $releaseRoot 'dist') -Recurse -Force

if (!(Test-Path -LiteralPath (Join-Path $releaseRoot 'dist\client\index.html')) -or !(Test-Path -LiteralPath (Join-Path $releaseRoot 'dist\server\index.js')) -or !(Test-Path -LiteralPath (Join-Path $releaseRoot 'dist\server\ssr\index.js'))) {
    throw "The staged frontend release is incomplete: $releaseRoot"
}

. (Join-Path $PSScriptRoot 'frontend-source-stamp.ps1')
[IO.File]::WriteAllText((Join-Path $releaseRoot 'source-stamp.txt'), (Get-TmsFrontendSourceStamp -ProjectRoot $ProjectRoot))
Write-Output $releaseRoot
