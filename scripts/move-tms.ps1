[CmdletBinding()]
param(
    [string]$Destination,
    [string]$LibraryRoot,
    [switch]$Apply,
    [switch]$Recover
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tms-relocation.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$journalDirectory = Join-Path $env:ProgramData 'TMS\Relocation'
$journalPath = Join-Path $journalDirectory 'pending.json'

function Assert-TmsOffline([string[]]$Roots) {
    $activeTasks = @(Get-ScheduledTask | Where-Object {
        $task = $_
        $task.State -ne 'Disabled' -and ($task.TaskName -like 'TMS*' -or @($task.Actions | Where-Object {
            $action = [string]$_.Execute + ' ' + [string]$_.Arguments + ' ' + [string]$_.WorkingDirectory
            @($Roots | Where-Object { $action.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
        }).Count -gt 0)
    })
    if ($activeTasks.Count) { throw "Disable TMS scheduled tasks first: $($activeTasks.TaskName -join ', ')" }
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $process = $_
        $command = [string]$process.CommandLine
        $process.ProcessId -ne $PID -and ($process.Name -in @('tms-server.exe', 'qbittorrent.exe') -or @($Roots | Where-Object {
            $command.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }).Count -gt 0)
    })
    if ($processes.Count) { throw "TMS or another process is using these folders (PIDs $($processes.ProcessId -join ', ')). Stop them before moving." }
    if (@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(3000, 8787) }).Count) {
        throw 'TMS ports are still listening. Stop TMS before moving.'
    }
}

if ($Apply -or $Recover) {
    if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run relocation or recovery from an administrator PowerShell window.'
    }
}
if ($Recover) {
    if ($Apply -or $Destination) { throw 'Use -Recover by itself.' }
    if (!(Test-Path -LiteralPath $journalPath)) { throw 'There is no interrupted relocation to recover.' }
    $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
    Assert-TmsOffline @($journal.entries.source + $journal.entries.destination)
    Set-Location -LiteralPath $env:SystemRoot
    [Environment]::CurrentDirectory = $env:SystemRoot
    Restore-TmsRelocation $journal $journalPath
    Write-Host 'Original locations restored. Staged copies were preserved. You may restart TMS.'
    exit
}
if (Test-Path -LiteralPath $journalPath) { throw 'An earlier move needs recovery. Run this script with -Recover before proceeding.' }
if (!$Destination -or $Destination -notmatch '^[A-Za-z]:[\\/]') { throw 'Specify a new local absolute destination, for example -Destination D:\TMS.' }
if (!$LibraryRoot) { $LibraryRoot = if ($env:TMS_LIBRARY_ROOT) { $env:TMS_LIBRARY_ROOT } else { 'C:\TariqsMediaServer' } }
$roots = @($projectRoot, [IO.Path]::GetFullPath($LibraryRoot).TrimEnd('\'))
$destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if (Test-Path -LiteralPath $destinationRoot) { throw 'The destination must not exist. Choose a new folder.' }
foreach ($root in $roots) {
    $item = Get-Item -LiteralPath $root -Force
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Source roots must be ordinary local directories. Use their physical paths.' }
    foreach ($other in @($roots | Where-Object { $_ -ine $root }) + @($destinationRoot)) {
        if ($other -ieq $root -or $other.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($other + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Installation, data and destination folders must be separate and must not contain one another.'
        }
    }
}
if ($roots[0] -ieq $roots[1]) { throw 'Installation and data roots must be separate.' }
$driveRoot = [IO.Path]::GetPathRoot($destinationRoot)
$volume = Get-Volume -DriveLetter $driveRoot.Substring(0, 1) -ErrorAction Stop
if ($volume.FileSystem -ne 'NTFS') { throw 'The destination must use NTFS so links and private data permissions can be preserved.' }
foreach ($root in $roots) {
    if ((Get-Volume -DriveLetter $root.Substring(0, 1)).FileSystem -ne 'NTFS') { throw 'Source roots must use NTFS.' }
}
$id = [Guid]::NewGuid().ToString('N')
$journal = [pscustomobject]@{ entries = @(
    [pscustomobject]@{ source = $roots[0]; destination = Join-Path $destinationRoot 'app'; backup = $roots[0] + '.before-move-' + $id },
    [pscustomobject]@{ source = $roots[1]; destination = Join-Path $destinationRoot 'data'; backup = $roots[1] + '.before-move-' + $id }
) }
$journal.entries | Select-Object source, destination, backup | Format-List
if (!$Apply) {
    Write-Host 'Preview only. Stop TMS, exit its tray icon, disable its scheduled tasks and close processes using either folder. Then repeat with -Apply in an administrator PowerShell window. No files changed.'
    exit
}
Assert-TmsOffline $roots
# Only administrators/SYSTEM can change the recovery plan. Local launchers need
# read access to detect the startup guard, including from an unelevated session.
New-Item -ItemType Directory -Path $journalDirectory -Force | Out-Null
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
$readers = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($readers, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -LiteralPath $journalDirectory -AclObject $acl
New-Item -ItemType Directory -Path $destinationRoot | Out-Null
Save-TmsRelocationJournal $journal $journalPath
try {
    # Block normal launchers for the entire copy, not only the final switch.
    Assert-TmsOffline $roots
    foreach ($entry in $journal.entries) {
        Write-Host "Staging $($entry.source)"
        Copy-TmsRelocationTree $entry.source $entry.destination
    }
    Assert-TmsOffline $roots
    foreach ($entry in $journal.entries) { Test-TmsRelocationTree $entry.source $entry.destination }
    Set-Location -LiteralPath $env:SystemRoot
    [Environment]::CurrentDirectory = $env:SystemRoot
    Invoke-TmsRelocationCutover $journal $journalPath -Prepared
} catch {
    $failure = $_
    if (Test-Path -LiteralPath $journalPath) { Restore-TmsRelocation $journal $journalPath }
    throw $failure
}
Write-Host 'Move completed. The old paths now point to the verified new installation and data. Startup tasks and saved paths continue to work.'
Write-Host 'Re-enable the tasks you disabled and start TMS normally. Verify playback, accounts and downloads before deleting the before-move backup folders shown above.'
Write-Host 'External media was not copied. Backups still use disk space until you explicitly remove them.'
