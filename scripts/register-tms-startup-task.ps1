param(
    [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this one-time installer as administrator. Unattended boot startup cannot be installed from a limited user session.'
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $projectRoot 'start_tms.ps1'
$supervisor = Join-Path $PSScriptRoot 'supervise-tms.ps1'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (!(Test-Path -LiteralPath $launcher)) {
    throw "TMS launcher was not found: $launcher"
}
if (!(Test-Path -LiteralPath $powershellExe)) {
    throw "Could not find Windows PowerShell: $powershellExe"
}
if (!(Test-Path -LiteralPath $supervisor)) {
    throw "TMS startup supervisor was not found: $supervisor"
}

$action = New-ScheduledTaskAction -Execute $powershellExe -Argument (
    '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $supervisor
)
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$bootTrigger.Delay = 'PT0S'
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$logonTrigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$registered = $false
try {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName 'TMS Server Startup' -Action $action -Trigger @($bootTrigger, $logonTrigger) `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host 'Registered TMS Server Startup to supervise as SYSTEM at boot and sign-in.'
    $registered = $true
    $activeTaskName = 'TMS Server Startup'
} catch {
    throw
}

if (!$registered) {
    throw 'Could not register a TMS startup supervisor task.'
}

$pickerScript = Join-Path $projectRoot 'scripts\tms-folder-picker-broker.ps1'
$hiddenRunner = Join-Path $PSScriptRoot 'run_hidden.vbs'
$pickerCommand = 'wscript.exe //B //Nologo "{0}" "{1}"' -f $hiddenRunner, $pickerScript
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-ItemProperty -Path $runKey -Name 'TMS Folder Picker Broker' -Value $pickerCommand -PropertyType String -Force | Out-Null
$pickerRunning = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'powershell.exe' -and $_.CommandLine -like "*$pickerScript*"
})
if (!$pickerRunning.Count) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('//B //Nologo "{0}" "{1}"' -f $hiddenRunner, $pickerScript) -WindowStyle Hidden
}
Write-Host 'Registered and started the TMS folder picker broker in the interactive desktop session.'

$trayLauncher = Join-Path $projectRoot 'scripts\start_tms_tray_hidden.vbs'
if (!(Test-Path -LiteralPath $trayLauncher)) {
    throw "TMS tray launcher was not found: $trayLauncher"
}
$trayCommand = 'wscript.exe //B //Nologo "{0}"' -f $trayLauncher
New-ItemProperty -Path $runKey -Name 'TMS Tray' -Value $trayCommand -PropertyType String -Force | Out-Null
Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', $trayLauncher) -WindowStyle Hidden
Write-Host 'Registered and started the TMS tray icon in the interactive desktop session.'

if ($RunNow) {
    Start-ScheduledTask -TaskName $activeTaskName
}
