$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
Hide-TmsConsoleWindow

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TmsTrayNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
'@

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$iconPath = Join-Path $projectRoot 'assets\icon.png'
$stopScript = Join-Path $projectRoot 'kill_tms.ps1'
$restartScript = Join-Path $PSScriptRoot 'restart_tms.ps1'
$webUrl = 'http://localhost:3000/'
$adminUrl = 'http://localhost:3000/admin'
. (Join-Path $projectRoot 'scripts\tms-paths.ps1')
$supervisorLog = Join-Path $dataRoot 'tms-startup-supervisor.log'

$createdIconHandle = [IntPtr]::Zero
$createdNew = $false
$sourceBitmap = $null
$notifyIcon = $null

function Open-TmsPage {
    param([string]$Url)
    Start-Process -FilePath $Url
}

function Start-ElevatedTmsScript {
    param([string]$ScriptPath)
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath
    )
}

function Test-TmsEndpoint {
    param([string]$Url)
    try {
        return (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3).StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-TmsFailureDetail {
    if (!(Test-Path -LiteralPath $supervisorLog)) {
        return 'The backend is not responding on port 8787.'
    }
    $failure = Get-Content -LiteralPath $supervisorLog -Tail 80 -ErrorAction SilentlyContinue |
        ForEach-Object { $_ -replace "`0", '' } |
        Where-Object { $_ -match 'Launcher failed:' } |
        Select-Object -Last 1
    if ($failure) {
        return ($failure -replace '^.*Launcher failed:\s*', '').Trim()
    }
    return 'The backend is restarting or not responding on port 8787.'
}

try {
    $singleInstance = [Threading.Mutex]::new($true, 'Local\TMS.TrayIcon', [ref]$createdNew)
    if (!$createdNew) {
        exit 0
    }

    $menu = [System.Windows.Forms.ContextMenuStrip]::new()
    $openTms = $menu.Items.Add('Open TMS')
    $openAdmin = $menu.Items.Add('Open Admin Panel')
    [void]$menu.Items.Add('-')
    $serviceStatus = $menu.Items.Add('Checking TMS server…')
    $serviceStatus.Enabled = $false
    [void]$menu.Items.Add('-')
    $restart = $menu.Items.Add('Restart TMS Server')
    $stop = $menu.Items.Add('Stop TMS Server')

    $openTms.add_Click({ Open-TmsPage -Url $webUrl })
    $openAdmin.add_Click({ Open-TmsPage -Url $adminUrl })
    $restart.add_Click({
        $notifyIcon.ShowBalloonTip(2500, 'TMS', 'Restarting the TMS server...', [System.Windows.Forms.ToolTipIcon]::Info)
        Start-ElevatedTmsScript -ScriptPath $restartScript
    })

    $stopAndExit = {
        $notifyIcon.Visible = $false
        Start-ElevatedTmsScript -ScriptPath $stopScript
        [System.Windows.Forms.Application]::Exit()
    }
    $stop.add_Click($stopAndExit)

    $sourceBitmap = [System.Drawing.Bitmap]::FromFile($iconPath)
    $createdIconHandle = $sourceBitmap.GetHicon()
    $notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
    $notifyIcon.Icon = [System.Drawing.Icon]::FromHandle($createdIconHandle)
    $notifyIcon.Text = "TMS - Tariq's Media Server"
    $notifyIcon.Visible = $true

    $lastServiceHealthy = $null
    $statusTimer = [System.Windows.Forms.Timer]::new()
    $statusTimer.Interval = 10000
    $refreshServiceStatus = {
        $frontendHealthy = Test-TmsEndpoint -Url 'http://127.0.0.1:3000/manifest.webmanifest'
        $backendHealthy = Test-TmsEndpoint -Url 'http://127.0.0.1:8787/api/health'
        $healthy = $frontendHealthy -and $backendHealthy
        if ($healthy) {
            $serviceStatus.Text = 'Server online'
            $notifyIcon.Text = "TMS - Server online"
            if ($lastServiceHealthy -eq $false) {
                $notifyIcon.ShowBalloonTip(5000, 'TMS recovered', 'The frontend and media server are responding again.', [System.Windows.Forms.ToolTipIcon]::Info)
            }
        } else {
            $detail = Get-TmsFailureDetail
            $serviceStatus.Text = 'Server needs attention'
            $notifyIcon.Text = 'TMS - Server needs attention'
            # Source saves intentionally restart the watched services. Keep the
            # tray state informative, but do not interrupt the user with a
            # balloon for those short-lived build/restart windows.
        }
        $lastServiceHealthy = $healthy
    }
    $statusTimer.add_Tick($refreshServiceStatus)
    & $refreshServiceStatus
    $statusTimer.Start()
    $notifyIcon.add_MouseUp({
        param($sender, $eventArgs)
        if ($eventArgs.Button -in @([System.Windows.Forms.MouseButtons]::Left, [System.Windows.Forms.MouseButtons]::Right)) {
            if ($menu.Visible) {
                $menu.Close()
            } else {
                $menu.Show([System.Windows.Forms.Cursor]::Position)
            }
        }
    })

    [System.Windows.Forms.Application]::Run()
} finally {
    if ($notifyIcon) {
        if ($statusTimer) {
            $statusTimer.Stop()
            $statusTimer.Dispose()
        }
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
    }
    if ($sourceBitmap) {
        $sourceBitmap.Dispose()
    }
    if ($createdIconHandle -ne [IntPtr]::Zero) {
        [void][TmsTrayNative]::DestroyIcon($createdIconHandle)
    }
    if ($singleInstance) {
        $singleInstance.ReleaseMutex()
        $singleInstance.Dispose()
    }
}
