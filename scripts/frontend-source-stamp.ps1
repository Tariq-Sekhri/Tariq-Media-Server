function Get-TmsFrontendSourceStamp {
    param([string]$ProjectRoot)
    $paths = @('app', 'public', 'next.config.ts', 'vite.config.ts', 'package.json', 'package-lock.json')
    $files = foreach ($path in $paths) {
        $item = Get-Item -LiteralPath (Join-Path $ProjectRoot $path) -ErrorAction SilentlyContinue
        if (!$item) { continue }
        if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $item.FullName -File -Recurse } else { $item }
    }
    return (($files | Sort-Object FullName | ForEach-Object { "$($_.FullName):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }) -join '|')
}
