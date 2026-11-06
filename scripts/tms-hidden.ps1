function Hide-TmsConsoleWindow {
    try {
        if (-not ('TmsConsoleNative' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TmsConsoleNative {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
        }
        $hwnd = [TmsConsoleNative]::GetConsoleWindow()
        if ($hwnd -ne [IntPtr]::Zero) {
            [void][TmsConsoleNative]::ShowWindow($hwnd, 0)
        }
    } catch {
    }
}

function Start-TmsHiddenProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string]$Arguments = '',
        [string]$WorkingDirectory = '',
        [string]$LogPath = '',
        [switch]$Wait
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()

    if ($LogPath) {
        $logDirectory = Split-Path -Parent $LogPath
        if ($logDirectory) {
            New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
        }
        $identity = "$FilePath|$Arguments|$LogPath|$WorkingDirectory"
        $hash = [BitConverter]::ToString(
            [System.Security.Cryptography.SHA1]::Create().ComputeHash(
                [System.Text.Encoding]::UTF8.GetBytes($identity)
            )
        ).Replace('-', '').Substring(0, 16)
        $wrapperPath = Join-Path $env:TEMP ("tms-hidden-$hash.cmd")
        $lines = @(
            '@echo off'
            '"' + $FilePath + '" ' + $Arguments + ' >> "' + $LogPath + '" 2>&1'
        )
        [System.IO.File]::WriteAllText($wrapperPath, ($lines -join "`r`n") + "`r`n")
        $startInfo.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $startInfo.Arguments = '/d /c "' + $wrapperPath + '"'
    } else {
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = $Arguments
    }

    if ($WorkingDirectory) {
        $startInfo.WorkingDirectory = $WorkingDirectory
    }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (!$process) {
        throw "Failed to start hidden process: $FilePath"
    }
    if ($Wait) {
        $process.WaitForExit()
        return $process.ExitCode
    }
    return $process.Id
}

function Invoke-TmsHiddenNative {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string]$Arguments,
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (!$process) {
        throw "Failed to start hidden native process: $FilePath"
    }
    $process.WaitForExit()
    return $process.ExitCode
}
