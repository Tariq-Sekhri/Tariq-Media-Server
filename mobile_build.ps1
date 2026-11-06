$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Set-Location -LiteralPath $projectRoot
. (Join-Path $projectRoot 'scripts\mobile-common.ps1')

$androidSdk = Get-TmsAndroidSdkRoot
$keystore = Read-TmsKeystoreProperties -ProjectRoot $projectRoot

$serverUrl = $env:TMS_CAPACITOR_SERVER_URL
if (!$serverUrl) {
    $serverUrl = Get-TmsTailscaleServerUrl
}
Write-Host 'Building signed TMS Android App Bundle for Play Store upload.'
if ($serverUrl) {
    Write-Host "Capacitor server URL: $serverUrl"
} else {
    Write-Host 'No TMS server URL is available; building the local Downloaded-only offline app.'
}
Write-Host ''
Write-Host 'Release signing key:'
Write-Host "  Keystore file: $($keystore.StoreFile)"
Write-Host "  Key alias:     $($keystore.KeyAlias)"
Write-Host "  Store password: $($keystore.StorePassword)"
Write-Host "  Key password:   $($keystore.KeyPassword)"
Write-Host ''

if ($serverUrl) {
    $env:TMS_CAPACITOR_SERVER_URL = $serverUrl
} else {
    Remove-Item Env:TMS_CAPACITOR_SERVER_URL -ErrorAction SilentlyContinue
}

Write-Host 'Building production web bundle...'
& npm run build
if ($LASTEXITCODE -ne 0) {
    throw 'Frontend production build failed.'
}

Write-Host 'Syncing Capacitor Android project...'
& npx cap sync android
if ($LASTEXITCODE -ne 0) {
    throw 'Capacitor sync failed.'
}

$gradlew = Join-Path $projectRoot 'android\gradlew.bat'
if (!(Test-Path -LiteralPath $gradlew)) {
    throw 'Gradle wrapper not found at android/gradlew.bat'
}

Write-Host 'Building signed release AAB...'
Push-Location -LiteralPath (Join-Path $projectRoot 'android')
try {
    & $gradlew clean bundleRelease
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle bundleRelease failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$gradleAabPath = Join-Path $projectRoot 'android\app\build\outputs\bundle\release\app-release.aab'
if (!(Test-Path -LiteralPath $gradleAabPath)) {
    throw "Expected AAB was not produced at $gradleAabPath"
}

$aabPath = Join-Path $projectRoot 'android\app-release.aab'
Copy-Item -LiteralPath $gradleAabPath -Destination $aabPath -Force
$aabInfo = Get-Item -LiteralPath $aabPath
Write-Host ''
Write-Host 'Signed release AAB ready:'
Write-Host "  $($aabInfo.FullName)"
Write-Host "  Size: $([math]::Round($aabInfo.Length / 1MB, 2)) MB"
Write-Host ''
Write-Host 'Upload this file to Google Play Console (Release > Production or Testing > Create new release).'
