# Filesystem primitives shared by the offline relocation tool and fixture tests.
function Copy-TmsRelocationAcl([string]$Source, [string]$Destination) {
    $acl = Get-Acl -LiteralPath $Source -ErrorAction Stop
    # Freeze inherited permissions rather than inheriting a broader destination ACL.
    $acl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $Destination -AclObject $acl -ErrorAction Stop
}

function Get-TmsRelocationEntries([string]$Root, [string]$Relative = '') {
    $directory = if ($Relative) { Join-Path $Root $Relative } else { $Root }
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
        $name = if ($Relative) { Join-Path $Relative $item.Name } else { $item.Name }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if ($item.LinkType -notin @('Junction', 'SymbolicLink') -or @($item.Target).Count -ne 1) {
                throw "Unsupported reparse point: $($item.FullName). Hydrate cloud files before relocating."
            }
            [pscustomobject]@{ Relative = $name; Kind = $item.LinkType; Target = [string]$item.Target[0] }
        } elseif ($item.PSIsContainer) {
            [pscustomobject]@{ Relative = $name; Kind = 'Directory'; Target = '' }
            Get-TmsRelocationEntries $Root $name
        } else {
            [pscustomobject]@{ Relative = $name; Kind = 'File'; Target = '' }
        }
    }
}

function Copy-TmsRelocationTree([string]$Source, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
    Copy-TmsRelocationAcl $Source $Destination
    $entries = @(Get-TmsRelocationEntries $Source)
    $index = 0
    foreach ($entry in $entries) {
        $index++
        Write-Progress -Activity 'Copying TMS' -Status "$index / $($entries.Count) entries" -PercentComplete (100 * $index / [Math]::Max(1, $entries.Count))
        $from = Join-Path $Source $entry.Relative
        $to = Join-Path $Destination $entry.Relative
        switch ($entry.Kind) {
            'File' { Copy-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop }
            'Directory' { New-Item -ItemType Directory -Path $to -ErrorAction Stop | Out-Null }
            default { New-Item -ItemType $entry.Kind -Path $to -Target $entry.Target -ErrorAction Stop | Out-Null }
        }
        if ($entry.Kind -in @('File', 'Directory')) {
            Copy-TmsRelocationAcl $from $to
        }
    }
    Write-Progress -Activity 'Copying TMS' -Completed
    Test-TmsRelocationTree $Source $Destination
}

function Test-TmsRelocationTree([string]$Source, [string]$Destination) {
    $original = @(Get-TmsRelocationEntries $Source)
    $copied = @(Get-TmsRelocationEntries $Destination)
    $byName = @{}
    foreach ($entry in $copied) { $byName[$entry.Relative] = $entry }
    if ($original.Count -ne $copied.Count) { throw 'Verification failed: entry count differs.' }
    $index = 0
    foreach ($entry in $original) {
        $index++
        Write-Progress -Activity 'Verifying TMS (SHA-256)' -Status "$index / $($original.Count) entries" -PercentComplete (100 * $index / [Math]::Max(1, $original.Count))
        $other = $byName[$entry.Relative]
        if (!$other -or $entry.Kind -ne $other.Kind -or $entry.Target -cne $other.Target) { throw "Verification failed: $($entry.Relative)" }
        if ($entry.Kind -eq 'File') {
            $from = Join-Path $Source $entry.Relative
            $to = Join-Path $Destination $entry.Relative
            if ((Get-Item -LiteralPath $from -Force).Length -ne (Get-Item -LiteralPath $to -Force).Length -or
                (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash) {
                throw "Verification failed: $($entry.Relative)"
            }
        }
    }
    Write-Progress -Activity 'Verifying TMS (SHA-256)' -Completed
}

function Save-TmsRelocationJournal($Journal, [string]$Path) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Journal | ConvertTo-Json -Depth 8))
    $temporary = $Path + '.writing-' + [Guid]::NewGuid().ToString('N')
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try { Move-Item -LiteralPath $temporary -Destination $Path -ErrorAction Stop }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

function Restore-TmsRelocation($Journal, [string]$JournalPath) {
    foreach ($entry in @($Journal.entries)[($Journal.entries.Count - 1)..0]) {
        if (!(Test-Path -LiteralPath $entry.backup)) { continue }
        $current = Get-Item -LiteralPath $entry.source -Force -ErrorAction SilentlyContinue
        if ($current) {
            if ($current.LinkType -ne 'Junction' -or [string]$current.Target[0] -ine $entry.destination) {
                throw "Recovery stopped: unexpected item at $($entry.source). Originals remain at $($entry.backup)."
            }
            # Delete only the verified junction, never its target tree.
            [IO.Directory]::Delete($entry.source)
        }
        Move-Item -LiteralPath $entry.backup -Destination $entry.source -ErrorAction Stop
    }
    Remove-Item -LiteralPath $JournalPath -ErrorAction Stop
}

function Invoke-TmsRelocationCutover($Journal, [string]$JournalPath, [switch]$Prepared) {
    # No source is touched until the complete recovery plan has reached disk.
    if (!$Prepared) { Save-TmsRelocationJournal $Journal $JournalPath }
    try {
        foreach ($entry in $Journal.entries) {
            Move-Item -LiteralPath $entry.source -Destination $entry.backup -ErrorAction Stop
            New-Item -ItemType Junction -Path $entry.source -Target $entry.destination -ErrorAction Stop | Out-Null
        }
        foreach ($entry in $Journal.entries) {
            $link = Get-Item -LiteralPath $entry.source -Force
            if ($link.LinkType -ne 'Junction' -or [string]$link.Target[0] -ine $entry.destination) { throw 'Cutover verification failed.' }
        }
    } catch {
        $failure = $_
        Restore-TmsRelocation $Journal $JournalPath
        throw $failure
    }
    Remove-Item -LiteralPath $JournalPath -ErrorAction Stop
}
