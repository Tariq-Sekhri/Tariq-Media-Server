$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $root 'scripts\tms-paths.ps1')
$data = $dataRoot
$status = Join-Path $data 'startup-repair-result.json'
Start-Transcript -Path (Join-Path $data 'startup-repair-install.log') -Append | Out-Null
try {
    if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required for boot task installation.' }
    $backup = Join-Path $data ('startup-backup-' + (Get-Date -Format yyyyMMdd-HHmmss))
    New-Item -ItemType Directory $backup | Out-Null
    foreach ($name in @('TMS Server Startup','TMS Server Startup User','PM2 Archivers Startup','TMS qBittorrent')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) { Export-ScheduledTask -TaskName $name | Set-Content (Join-Path $backup ($name + '.xml')) }
        if ($task -and $name -like 'TMS Server Startup*') { Stop-ScheduledTask -TaskName $name; Disable-ScheduledTask -TaskName $name | Out-Null }
    }
    # Stop only supervisors/launchers belonging to this checkout, including old elevated instances.
    $processes = @(Get-CimInstance Win32_Process)
    $seeds = [Collections.Generic.HashSet[int]]::new()
    foreach ($p in $processes) {
        if ($p.Name -in @('powershell.exe','pwsh.exe') -and $p.CommandLine -like "*$root*" -and $p.CommandLine -match '(supervise-tms|start_tms|backend-dev|backend-run-loop)\.ps1' -and $p.ProcessId -ne $PID) { [void]$seeds.Add([int]$p.ProcessId) }
    }
    . (Join-Path $PSScriptRoot 'tms-processes.ps1')
    if ($seeds.Count) { [void](Expand-ProcessTree -SeedPids $seeds -Processes $processes); Stop-Process -Id @($seeds) -Force -ErrorAction SilentlyContinue }
    $stopArgs = @{ ProjectRoot=$root; BackendExe=(Join-Path $root 'backend\target\debug\tms-server.exe'); FrontendLog=(Join-Path $data 'tms-frontend.log'); BackendLog=(Join-Path $data 'tms-backend.log'); DataRoot=$data }
    Stop-TmsProcesses @stopArgs -Component backend | Out-Null
    Stop-TmsProcesses @stopArgs -Component frontend | Out-Null
    & (Join-Path $PSScriptRoot 'register-tms-startup-task.ps1')
    $userTask = Get-ScheduledTask -TaskName 'TMS Server Startup User' -ErrorAction SilentlyContinue
    if ($userTask) { Unregister-ScheduledTask -TaskName $userTask.TaskName -Confirm:$false }
    $pm2 = Get-ScheduledTask -TaskName 'PM2 Archivers Startup' -ErrorAction SilentlyContinue
    if ($pm2) {
        $pm2Script = 'C:\Users\hulks\Documents\Codex\2026-08-28\so-x20\outputs\Register-Always-On-Services.ps1'
        $args = '//B //Nologo "{0}" "{1}" -RestorePm2Only' -f (Join-Path $PSScriptRoot 'run_hidden.vbs'), $pm2Script
        $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument $args
        Set-ScheduledTask -TaskName $pm2.TaskName -Action $action | Out-Null
    }
    Start-ScheduledTask -TaskName 'TMS Server Startup'
    $tasks = @(Get-ScheduledTask -TaskName 'TMS Server Startup','PM2 Archivers Startup' | ForEach-Object {
        [pscustomobject]@{ Name=$_.TaskName; User=$_.Principal.UserId; Logon=[string]$_.Principal.LogonType; Actions=@($_.Actions | Select-Object Execute,Arguments); Triggers=@($_.Triggers | ForEach-Object {$_.CimClass.CimClassName}); Hidden=$_.Settings.Hidden }
    })
    @{Success=$true;Tasks=$tasks;Backup=$backup;Time=(Get-Date -Format o)} | ConvertTo-Json -Depth 6 | Set-Content $status
} catch {
    @{Success=$false;Error="$_";Time=(Get-Date -Format o)} | ConvertTo-Json | Set-Content $status
    throw
} finally { Stop-Transcript | Out-Null }
