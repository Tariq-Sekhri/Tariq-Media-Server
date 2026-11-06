<#
Registers magnet: links to TMS for the current Windows user.

This is intentionally a single-file installer: it copies itself into LocalAppData
before registering the protocol, so the original file can be deleted or sent to
someone else after installation. It only opens TMS in a browser; it does not
need a local TMS checkout or start any local services.
#>
param(
    # The TMS server address. Defaults to TMS_TAILSCALE_HOST from the
    # environment or from a .env file next to this script.
    [string]$TmsHost = '',
    [ValidateRange(1, 65535)]
    [int]$TmsPort = 3000,
    [string]$MagnetUri,
    [switch]$HandleMagnet
)

$ErrorActionPreference = 'Stop'

function Invoke-TmsMagnetHandler {
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Uri
    )

    if (!$Uri.Trim().StartsWith('magnet:?', [System.StringComparison]::OrdinalIgnoreCase)) {
        exit 1
    }
    $encodedMagnet = [System.Uri]::EscapeDataString($Uri.Trim())
    # The web app consumes the `magnet` query parameter at its root route.
    # This is deliberately not /magnet: that route does not exist.
    Start-Process -FilePath "http://${HostName}:$Port/?magnet=$encodedMagnet"
}

if ($HandleMagnet) {
    Invoke-TmsMagnetHandler -HostName $TmsHost -Port $TmsPort -Uri $MagnetUri
    exit 0
}

if (!$TmsHost) { $TmsHost = $env:TMS_TAILSCALE_HOST }
$envFile = Join-Path $PSScriptRoot '.env'
if (!$TmsHost -and (Test-Path -LiteralPath $envFile)) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*TMS_TAILSCALE_HOST\s*=' } | Select-Object -First 1
    if ($line) { $TmsHost = ($line -split '=', 2)[1].Trim().Trim('"', "'") }
}
if (!$TmsHost) {
    throw 'Set TMS_TAILSCALE_HOST in .env next to this script, or pass -TmsHost <server address>.'
}

$installDirectory = Join-Path $env:LOCALAPPDATA 'TMS\magnet-handler'
$installedScript = Join-Path $installDirectory 'install_tms_magnet_handler.ps1'
$launcherScript = Join-Path $installDirectory 'open_tms_magnet.vbs'
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
if ((Resolve-Path -LiteralPath $PSCommandPath).Path -ne $installedScript) {
    Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force
}
if (!(Test-Path -LiteralPath $wscriptExe)) {
    throw "Could not find Windows Script Host: $wscriptExe"
}

# Windows protocol handlers can briefly show a console even with PowerShell's
# WindowStyle argument.  The installer writes this tiny launcher itself, so the
# file shared with another person is still just this one PowerShell installer.
$launcherContents = @"
Option Explicit

If WScript.Arguments.Count <> 1 Then WScript.Quit 1

Dim shell, powerShell, handlerScript, command
Set shell = CreateObject("WScript.Shell")
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
handlerScript = "$installedScript"
command = Chr(34) & powerShell & Chr(34) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & handlerScript & Chr(34) & " -HandleMagnet -TmsHost " & Chr(34) & "$TmsHost" & Chr(34) & " -TmsPort $TmsPort -MagnetUri " & Chr(34) & WScript.Arguments(0) & Chr(34)
shell.Run command, 0, False
"@
[System.IO.File]::WriteAllText($launcherScript, $launcherContents, [System.Text.UTF8Encoding]::new($false))

$protocolKey = 'HKCU:\Software\Classes\magnet'
$progIdKey = 'HKCU:\Software\Classes\TMS.Magnet'
$commandKey = Join-Path $protocolKey 'shell\open\command'
$progIdCommandKey = Join-Path $progIdKey 'shell\open\command'
$capabilitiesKey = 'HKCU:\Software\TMS\Capabilities'
$urlAssociationsKey = Join-Path $capabilitiesKey 'URLAssociations'
$registeredApplicationsKey = 'HKCU:\Software\RegisteredApplications'
$command = '"{0}" "{1}" "%1"' -f $wscriptExe, $launcherScript

New-Item -Path $commandKey -Force | Out-Null
New-Item -Path $progIdCommandKey -Force | Out-Null
New-Item -Path $urlAssociationsKey -Force | Out-Null
New-Item -Path $registeredApplicationsKey -Force | Out-Null
Set-Item -Path $protocolKey -Value 'URL:TMS Magnet Link'
New-ItemProperty -Path $protocolKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path $commandKey -Value $command
Set-Item -Path $progIdKey -Value 'TMS Magnet Link'
New-ItemProperty -Path $progIdKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path $progIdCommandKey -Value $command
New-ItemProperty -Path $capabilitiesKey -Name 'ApplicationName' -Value 'TMS' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $capabilitiesKey -Name 'ApplicationDescription' -Value 'Open magnet links in TMS and choose a Movies & TV destination.' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $urlAssociationsKey -Name 'magnet' -Value 'TMS.Magnet' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registeredApplicationsKey -Name 'TMS' -Value 'Software\TMS\Capabilities' -PropertyType String -Force | Out-Null

if (-not ('TmsAssociationNotifier' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TmsAssociationNotifier {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
}
[TmsAssociationNotifier]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "magnet: links now open http://${TmsHost}:$TmsPort for the current Windows user."
