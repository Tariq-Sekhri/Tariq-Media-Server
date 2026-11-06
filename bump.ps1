param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Type
)

$ErrorActionPreference = 'Stop'

$bumpType = switch ($Type.ToLowerInvariant()) {
    'major' { 'major' }
    'ma' { 'major' }
    'minor' { 'minor' }
    'mi' { 'minor' }
    'patch' { 'patch' }
    'p' { 'patch' }
    default { throw 'Usage: .\bump.ps1 <major|ma|minor|mi|patch|p>' }
}

function Write-Utf8File {
    param([string]$Path, [string]$Contents)
    [System.IO.File]::WriteAllText($Path, $Contents, [System.Text.UTF8Encoding]::new($false))
}

function Replace-FirstMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$Pattern,
        [Parameter(Mandatory = $true)]
        [string]$Replacement
    )

    $regex = [regex]::new($Pattern)
    return $regex.Replace($Text, $Replacement, 1)
}

function Set-JsonVersionField {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Json,
        [Parameter(Mandatory = $true)]
        [string]$OldVersion,
        [Parameter(Mandatory = $true)]
        [string]$NewVersion,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $updated = Replace-FirstMatch `
        -Text $Json `
        -Pattern (('("version"\s*:\s*")' + [regex]::Escape($OldVersion) + '(")')) `
        -Replacement ('${1}' + $NewVersion + '${2}')
    if ($updated -eq $Json) {
        throw "Could not update $Label version $OldVersion."
    }
    return $updated
}

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$packagePath = Join-Path $projectRoot 'package.json'
$lockPath = Join-Path $projectRoot 'package-lock.json'
$androidBuildPath = Join-Path $projectRoot 'android\app\build.gradle'
$packageJson = Get-Content -LiteralPath $packagePath -Raw
if ($packageJson -notmatch '"version"\s*:\s*"(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)"') {
    throw 'Invalid semver in package.json'
}
$major = [int]$Matches['major']
$minor = [int]$Matches['minor']
$patch = [int]$Matches['patch']
$oldVersion = '{0}.{1}.{2}' -f $major, $minor, $patch
$newVersion = switch ($bumpType) {
    'major' { '{0}.0.0' -f ($major + 1) }
    'minor' { '{0}.{1}.0' -f $major, ($minor + 1) }
    'patch' { '{0}.{1}.{2}' -f $major, $minor, ($patch + 1) }
}

$androidBuild = Get-Content -LiteralPath $androidBuildPath -Raw
if ($androidBuild -notmatch 'versionCode\s+(\d+)') {
    throw "$androidBuildPath does not contain versionCode"
}
$newVersionCode = [int]$Matches[1] + 1
$androidBuild = Replace-FirstMatch -Text $androidBuild -Pattern 'versionCode\s+\d+' -Replacement "versionCode $newVersionCode"
$androidBuild = Replace-FirstMatch -Text $androidBuild -Pattern 'versionName\s+"[^"]+"' -Replacement "versionName `"$newVersion`""

$packageJson = Set-JsonVersionField -Json $packageJson -OldVersion $oldVersion -NewVersion $newVersion -Label 'package.json'

# Windows PowerShell 5.1 cannot ConvertFrom-Json package-lock.json because
# packages uses an empty-string key (""). Update the two root version fields
# with targeted replacements instead of round-tripping the whole lockfile.
$lockJson = Get-Content -LiteralPath $lockPath -Raw
$lockJson = Set-JsonVersionField -Json $lockJson -OldVersion $oldVersion -NewVersion $newVersion -Label 'package-lock.json'
$escapedOld = [regex]::Escape($oldVersion)
$packagesRootPattern = '("packages"\s*:\s*\{\s*' + '""' + '\s*:\s*\{[^\}]*?"version"\s*:\s*")' + $escapedOld + '(")'
$updatedPackagesRoot = Replace-FirstMatch -Text $lockJson -Pattern $packagesRootPattern -Replacement ('${1}' + $newVersion + '${2}')
if ($updatedPackagesRoot -eq $lockJson) {
    throw 'Could not update package-lock.json packages[""].version.'
}
$lockJson = $updatedPackagesRoot

Write-Utf8File -Path $packagePath -Contents $packageJson
Write-Utf8File -Path $lockPath -Contents $lockJson
Write-Utf8File -Path $androidBuildPath -Contents $androidBuild

Write-Host "Bumped $oldVersion -> $newVersion ($bumpType)"
Write-Host "Android versionCode -> $newVersionCode"
Write-Host "Android versionName -> $newVersion"
