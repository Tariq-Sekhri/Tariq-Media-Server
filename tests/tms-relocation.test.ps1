$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\tms-relocation.ps1')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('tms-relocation-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
function Assert([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function New-Fixture([string]$Name) {
    $root = Join-Path $fixtureRoot $Name
    New-Item -ItemType Directory -Path $root | Out-Null
    $entries = @(foreach ($label in @('app', 'data')) {
        $source = Join-Path $root $label
        New-Item -ItemType Directory -Path $source | Out-Null
        Set-Content -LiteralPath (Join-Path $source 'content.txt') -Value $label
        [pscustomobject]@{ source = $source; destination = Join-Path $root ($label + '-new'); backup = Join-Path $root ($label + '-backup') }
    })
    [pscustomobject]@{ Root = $root; Journal = [pscustomobject]@{ entries = $entries }; Path = Join-Path $root 'pending.json' }
}
try {
    $copy = New-Fixture 'copy'
    $first = $copy.Journal.entries[0]
    $outside = Join-Path $copy.Root 'external'
    New-Item -ItemType Directory -Path $outside | Out-Null
    Set-Content -LiteralPath (Join-Path $outside 'untouched.txt') -Value 'external'
    New-Item -ItemType Directory -Path (Join-Path $first.source 'empty') | Out-Null
    Set-Content -LiteralPath (Join-Path $first.source '.hidden') -Value 'hidden'
    (Get-Item -LiteralPath (Join-Path $first.source '.hidden')).Attributes = 'Hidden'
    New-Item -ItemType Junction -Path (Join-Path $first.source 'mounted') -Target $outside | Out-Null
    Copy-TmsRelocationTree $first.source $first.destination
    Assert ((Get-Item -LiteralPath (Join-Path $first.destination 'mounted')).LinkType -eq 'Junction') 'Mount was traversed instead of recreated.'
    Assert (Test-Path -LiteralPath (Join-Path $first.destination '.hidden')) 'Hidden file missing.'
    Set-Content -LiteralPath (Join-Path $first.destination 'content.txt') -Value 'corrupt'
    $rejected = $false
    try { Test-TmsRelocationTree $first.source $first.destination } catch { $rejected = $true }
    Assert $rejected 'Corrupt copy passed verification.'
    Write-Host 'PASS copy, hidden files, empty directories, external links and corruption rejection'

    $success = New-Fixture 'success'
    foreach ($entry in $success.Journal.entries) { Copy-TmsRelocationTree $entry.source $entry.destination }
    Invoke-TmsRelocationCutover $success.Journal $success.Path
    foreach ($entry in $success.Journal.entries) {
        Assert ((Get-Item -LiteralPath $entry.source).LinkType -eq 'Junction') 'Compatibility path missing.'
        Assert (Test-Path -LiteralPath (Join-Path $entry.backup 'content.txt')) 'Original backup missing.'
        Assert ((Get-Content -LiteralPath (Join-Path $entry.source 'content.txt')) -eq (Split-Path $entry.source -Leaf)) 'Compatibility path points at wrong content.'
    }
    Assert (!(Test-Path -LiteralPath $success.Path)) 'Completed move left startup blocked.'
    Write-Host 'PASS successful two-root cutover and retained backups'

    $failure = New-Fixture 'failure'
    foreach ($entry in $failure.Journal.entries) { Copy-TmsRelocationTree $entry.source $entry.destination }
    # Inject a failure on the second junction, after the first root was switched.
    $script:failLink = $failure.Journal.entries[1].source
    function New-Item {
        param($ItemType, $Path, $Target, $ErrorAction)
        if ($ItemType -eq 'Junction' -and $Path -eq $script:failLink) { throw 'Injected second-root failure' }
        Microsoft.PowerShell.Management\New-Item @PSBoundParameters
    }
    $rejected = $false
    try { Invoke-TmsRelocationCutover $failure.Journal $failure.Path } catch { $rejected = $true }
    Remove-Item Function:\New-Item
    Assert $rejected 'Injected failure was not reported.'
    foreach ($entry in $failure.Journal.entries) {
        Assert (!(Get-Item -LiteralPath $entry.source).LinkType) 'Failure left a partially switched root.'
        Assert (Test-Path -LiteralPath (Join-Path $entry.source 'content.txt')) 'Failure lost original content.'
    }
    Assert (!(Test-Path -LiteralPath $failure.Path)) 'Successful rollback left startup blocked.'
    Write-Host 'PASS failure on second root restores both originals'

    $crash = New-Fixture 'crash'
    foreach ($entry in $crash.Journal.entries) { Copy-TmsRelocationTree $entry.source $entry.destination }
    Save-TmsRelocationJournal $crash.Journal $crash.Path
    $entry = $crash.Journal.entries[0]
    Move-Item -LiteralPath $entry.source -Destination $entry.backup
    # Simulate process death between rename and junction creation, then reload disk journal.
    Restore-TmsRelocation (Get-Content -LiteralPath $crash.Path -Raw | ConvertFrom-Json) $crash.Path
    Assert (Test-Path -LiteralPath (Join-Path $entry.source 'content.txt')) 'Crash recovery did not restore original.'
    Assert (!(Test-Path -LiteralPath $crash.Path)) 'Crash recovery left startup blocked.'
    Write-Host 'PASS durable journal recovery between rename and link creation'

    $guard = New-Fixture 'guard'
    foreach ($entry in $guard.Journal.entries) { Copy-TmsRelocationTree $entry.source $entry.destination }
    Save-TmsRelocationJournal $guard.Journal $guard.Path
    $entry = $guard.Journal.entries[0]
    Move-Item -LiteralPath $entry.source -Destination $entry.backup
    New-Item -ItemType Directory -Path $entry.source | Out-Null
    Set-Content -LiteralPath (Join-Path $entry.source 'unrelated.txt') -Value 'keep'
    $rejected = $false
    try { Restore-TmsRelocation $guard.Journal $guard.Path } catch { $rejected = $true }
    Assert $rejected 'Recovery replaced an unexpected directory.'
    Assert (Test-Path -LiteralPath (Join-Path $entry.source 'unrelated.txt')) 'Recovery deleted unrelated data.'
    Assert (Test-Path -LiteralPath $guard.Path) 'Failed recovery cleared the startup guard.'
    Write-Host 'PASS recovery preserves unexpected items and retains startup guard'

    $previousProgramData = $env:ProgramData
    try {
        $env:ProgramData = $fixtureRoot
        $guardDirectory = Join-Path $fixtureRoot 'TMS\Relocation'
        New-Item -ItemType Directory -Path $guardDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $guardDirectory 'pending.json') -Value '{}'
        $rejected = $false
        try { . (Join-Path $PSScriptRoot '..\scripts\tms-paths.ps1') } catch { $rejected = $true }
        Assert $rejected 'Normal startup ignored a pending relocation.'
        Remove-Item -LiteralPath (Join-Path $guardDirectory 'pending.json')
        . (Join-Path $PSScriptRoot '..\scripts\tms-paths.ps1')
        Write-Host 'PASS normal startup is blocked only while recovery is pending'
    } finally { $env:ProgramData = $previousProgramData }
} finally {
    # Do not recursively remove a tree containing junctions. Remove each known
    # link itself first, then delete only this resolved, uniquely named fixture.
    foreach ($entry in @(Get-TmsRelocationEntries $fixtureRoot)) {
        if ($entry.Kind -in @('Junction', 'SymbolicLink')) { [IO.Directory]::Delete((Join-Path $fixtureRoot $entry.Relative)) }
    }
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    if (!$resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'tms-relocation-test-*') { throw 'Unsafe fixture cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
