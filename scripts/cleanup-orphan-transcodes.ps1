param([switch]$Apply)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tms-paths.ps1')
$mediaRoot = [IO.Path]::GetFullPath($libraryRoot).TrimEnd('\')
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $dataRoot 'transcodes')).TrimEnd('\')
$trashPath = Join-Path $dataRoot 'trash.json'
# Missing or unreadable trash metadata must never turn recoverable media into orphans.
$trash = @(Get-Content -LiteralPath $trashPath -Raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
$activeCommands = @(Get-CimInstance Win32_Process -Filter "name='ffmpeg.exe'" | ForEach-Object { $_.CommandLine })
$report = @()
foreach ($directory in Get-ChildItem -LiteralPath $cacheRoot -Directory) {
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($directory.Name -notmatch '^[a-f0-9]{16}$') { continue }
    $target = [IO.Path]::GetFullPath($directory.FullName)
    if ([IO.Path]::GetDirectoryName($target) -ne $cacheRoot) { throw "Cache target escaped root: $target" }
    $source = $null
    $marker = Join-Path $target 'source-path.txt'
    if (Test-Path -LiteralPath $marker) {
        $source = (Get-Content -LiteralPath $marker -Raw -Encoding UTF8).Trim()
    } elseif (Test-Path -LiteralPath (Join-Path $target 'master.m3u8')) {
        $master = Get-Content -LiteralPath (Join-Path $target 'master.m3u8') -Raw -Encoding UTF8
        if ($master -match '[?&]video_path=([^&\r\n]+)') { $source = [Uri]::UnescapeDataString($Matches[1]) }
    } elseif (Test-Path -LiteralPath (Join-Path $target 'ffmpeg.log')) {
        foreach ($line in Get-Content -LiteralPath (Join-Path $target 'ffmpeg.log') -TotalCount 256 -Encoding UTF8) {
            if ($line -match "^Input #0,.*?, from '(.*)':$") { $source = $Matches[1]; break }
        }
    }
    $logical = $null
    if ($source) {
        $source = $source.Replace('\', '/')
        $normalizedRoot = $mediaRoot.Replace('\', '/') + '/'
        if ($source.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $logical = $source.Substring($normalizedRoot.Length)
        } elseif ($source -match '/Tariqs(?:Media|Meida)Server/(.+)$') {
            $logical = $Matches[1]
        } elseif ($source -notmatch '[:]' -and !$source.StartsWith('/')) {
            $logical = $source
        }
        if ($logical -and @($logical.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count) { $logical = $null }
    }
    $reason = 'unknown source'
    if ($activeCommands | Where-Object { $_ -and $_.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) {
        $reason = 'active transcode'
    } elseif (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) {
        $reason = 'empty cache'
    } elseif ($logical) {
        $mediaPath = [IO.Path]::GetFullPath((Join-Path $mediaRoot $logical))
        if (!$mediaPath.StartsWith($mediaRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Source escaped media root: $mediaPath" }
        $recoverable = @($trash | Where-Object {
            if (!$_.original_path) { return $false }
            $original = $_.original_path.Replace('\', '/').TrimEnd('/')
            $logical -eq $original -or $logical.StartsWith($original + '/', [StringComparison]::OrdinalIgnoreCase)
        }).Count -gt 0
        if (Test-Path -LiteralPath $mediaPath -PathType Leaf) { $reason = 'source exists' }
        elseif ($recoverable) { $reason = 'recoverable in trash' }
        else { $reason = 'orphan' }
    }
    $bytes = 0L
    if ($reason -in @('orphan', 'empty cache')) {
        $bytes = [long](Get-ChildItem -LiteralPath $target -File -Recurse | Measure-Object Length -Sum).Sum
        if ($Apply) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
    $report += [pscustomobject]@{ Cache = $directory.Name; Source = $logical; Reason = $reason; Bytes = $bytes; Removed = ($Apply -and $reason -in @('orphan', 'empty cache')) }
}
$report
