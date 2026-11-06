param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly
)

$ErrorActionPreference = 'Stop'

if ($BackendOnly -and $FrontendOnly) {
    throw 'BackendOnly and FrontendOnly cannot be used together.'
}

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Set-Location -LiteralPath $projectRoot
. (Join-Path $projectRoot 'scripts\tms-hidden.ps1')
Hide-TmsConsoleWindow

# The server can also be started by a Scheduled Task at boot, before a user has
# signed in. That task runs as SYSTEM and does not inherit this user's Cargo or
# npm locations, so make the required developer tools available explicitly.
$projectOwnerProfile = [regex]::Match($projectRoot, '^[A-Za-z]:\\Users\\[^\\]+').Value
$requiredToolDirectories = @(
    $(if ($projectOwnerProfile) { Join-Path $projectOwnerProfile '.cargo\\bin' }),
    $(if ($projectOwnerProfile) { Join-Path $projectOwnerProfile 'AppData\\Roaming\\npm' }),
    'C:\\Program Files\\nodejs'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$existingPathEntries = @($env:Path -split ';' | Where-Object { $_ })
$env:Path = @($requiredToolDirectories + $existingPathEntries | Select-Object -Unique) -join ';'

# cargo.exe is a rustup proxy. At boot the task runs as SYSTEM, whose default
# profile has no installed Rust toolchain, even though cargo itself is found
# through the project owner's PATH above. Point rustup at the same owner
# profile so this exact launcher works before anyone signs in.
if ($projectOwnerProfile) {
    $projectCargoHome = Join-Path $projectOwnerProfile '.cargo'
    $projectRustupHome = Join-Path $projectOwnerProfile '.rustup'
    if (Test-Path -LiteralPath $projectCargoHome) {
        $env:CARGO_HOME = $projectCargoHome
    }
    if (Test-Path -LiteralPath $projectRustupHome) {
        $env:RUSTUP_HOME = $projectRustupHome
    }
}

. (Join-Path $projectRoot 'scripts\tms-processes.ps1')
$secretsPath = Join-Path $projectRoot 'password.md'

if (Test-Path -LiteralPath $secretsPath) {
    $allowedSecretNames = @(
        'TMS_QBITTORRENT_URL',
        'TMS_QBITTORRENT_USERNAME',
        'TMS_QBITTORRENT_PASSWORD',
        'TMS_VPN_INTERFACE',
        'TMS_WYZIE_API_KEY',
        'TMS_SUBDL_API_KEY'
    )
    foreach ($rawLine in Get-Content -LiteralPath $secretsPath) {
        $line = $rawLine.Trim()
        if (!$line -or $line.StartsWith('#')) {
            continue
        }
        $match = [regex]::Match($line, '^(?<name>TMS_[A-Z0-9_]+)=(?<value>.*)$')
        if (!$match.Success -or $match.Groups['name'].Value -notin $allowedSecretNames) {
            throw "Invalid password.md entry. Use NAME=value for one of: $($allowedSecretNames -join ', ')"
        }
        Set-Item -Path "Env:$($match.Groups['name'].Value)" -Value $match.Groups['value'].Value
    }
}

. (Join-Path $projectRoot 'scripts\tms-paths.ps1')
$dataRoot = Join-Path $libraryRoot '.tms-data'
$frontendLog = Join-Path $dataRoot 'tms-frontend.log'
$frontendWatcherLog = Join-Path $dataRoot 'tms-frontend-watcher.log'
$backendLog = Join-Path $dataRoot 'tms-backend.log'
$frontendPort = 3000
$backendPort = 8787
$firewallRuleName = "TMS frontend (TCP $frontendPort)"
$backendFirewallRuleName = "TMS private API (TCP $backendPort)"

$frontendBindAddress = if ($env:TMS_FRONTEND_BIND_ADDRESS) { $env:TMS_FRONTEND_BIND_ADDRESS } else { '0.0.0.0' }
$frontendIsLoopbackOnly = $frontendBindAddress -in @('127.0.0.1', 'localhost', '::1')

$tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'
$tailscaleDnsName = $null
$tailscaleAddresses = @()
if (Test-Path -LiteralPath $tailscaleExe) {
    try {
        $tailscaleStatus = & $tailscaleExe status --json | ConvertFrom-Json
        $tailscaleDnsName = ([string]$tailscaleStatus.Self.DNSName).TrimEnd('.')
        $tailscaleAddresses = @($tailscaleStatus.Self.TailscaleIPs)
    } catch {
        Write-Warning 'Tailscale is installed, but its device name could not be read.'
    }
}

$machineName = [System.Net.Dns]::GetHostName()
$allowedHosts = [System.Collections.Generic.List[string]]::new()
foreach ($candidate in @($env:TMS_ALLOWED_HOSTS -split ',') + @($tailscaleDnsName, $machineName, "$machineName.local")) {
    $trimmed = ([string]$candidate).Trim()
    if ($trimmed -and !$allowedHosts.Contains($trimmed)) {
        $allowedHosts.Add($trimmed)
    }
}

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$env:TMS_LIBRARY_ROOT = $libraryRoot
# The private web app uses this backend through the frontend proxy. Authentication
# is still required on every user route; the firewall keeps this port Tailnet-only.
$env:TMS_BIND_ADDRESS = '0.0.0.0'
$env:TMS_FRONTEND_BIND_ADDRESS = $frontendBindAddress
$env:TMS_ALLOWED_HOSTS = $allowedHosts -join ','

function Enable-TmsFirewallRule {
    param(
        [string]$RuleName,
        [int]$Port,
        [string[]]$RemoteAddresses = @('LocalSubnet', '100.64.0.0/10', 'fd7a:115c:a1e0::/48')
    )

    if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
        return
    }

    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    try {
        if ($isAdmin) {
            New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP `
                -LocalPort $Port -Profile Any -RemoteAddress $RemoteAddresses | Out-Null
        } else {
            Write-Warning "Firewall rule $RuleName requires the one-time elevated startup installer."
            return
        }
    } catch {
        Write-Warning "Could not add the firewall rule for port $Port. Other computers may be blocked."
        return
    }

    if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
        Write-Host "Allowed inbound TCP $Port from the configured private networks."
    } else {
        Write-Warning "The firewall rule for port $Port was not created. Other computers may be blocked."
    }
}

$backendExe = Join-Path $projectRoot 'backend\target\debug\tms-server.exe'
$startupTaskNames = @('TMS Server Startup', 'TMS Server Startup User')
$startupTaskName = $startupTaskNames | Where-Object {
    Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue
} | Select-Object -First 1
if (!$startupTaskName) {
    $startupTaskName = 'TMS Server Startup'
}
$qbittorrentRestartTaskName = 'TMS qBittorrent'
$qbittorrentExe = if ($env:TMS_QBITTORRENT_EXE) {
    $env:TMS_QBITTORRENT_EXE
} else {
    'C:\Program Files\qBittorrent\qbittorrent.exe'
}
$qbittorrentWatchdog = Join-Path $projectRoot 'scripts\watch-qbittorrent.ps1'
$qbittorrentWatchdogLog = Join-Path $dataRoot 'qbittorrent-watchdog.log'
$qbittorrentWebUiPort = 8181
if ($env:TMS_QBITTORRENT_URL) {
    try {
        $configuredQbittorrentUri = [uri]$env:TMS_QBITTORRENT_URL
        if ($configuredQbittorrentUri.Port -gt 0) {
            $qbittorrentWebUiPort = $configuredQbittorrentUri.Port
        }
    } catch {
        Write-Warning 'TMS_QBITTORRENT_URL is not a valid URL; the qBittorrent watchdog will check port 8181.'
    }
}

function Test-TmsScriptProcess {
    param([string]$ScriptPath)

    if (!$ScriptPath) {
        return $false
    }

    return [bool]@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'powershell.exe' -and [string]$_.CommandLine -like "*$ScriptPath*"
    })
}

function Ensure-QbittorrentRestartTask {
    if (!(Test-Path -LiteralPath $qbittorrentExe -PathType Leaf)) {
        Write-Warning "qBittorrent was not found at $qbittorrentExe; automatic magnet recovery cannot be configured."
        return
    }
    if (!$projectOwnerProfile) {
        Write-Warning 'Could not identify the project owner; automatic qBittorrent recovery cannot be configured.'
        return
    }
    if (!(Test-Path -LiteralPath $qbittorrentWatchdog -PathType Leaf)) {
        Write-Warning "The qBittorrent watchdog was not found at $qbittorrentWatchdog."
        return
    }

    $ownerName = Split-Path -Leaf $projectOwnerProfile
    $taskUser = "$env:COMPUTERNAME\$ownerName"
    $powershellExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $watchdogArguments = '//B //Nologo "' + (Join-Path $projectRoot 'scripts\run_hidden.vbs') + '" ' +
        "`"$qbittorrentWatchdog`" -QbittorrentPath `"$qbittorrentExe`" " +
        "-WebUiPort $qbittorrentWebUiPort -LogPath `"$qbittorrentWatchdogLog`""
    try {
        $existing = Get-ScheduledTask -TaskName $qbittorrentRestartTaskName -ErrorAction SilentlyContinue
        $correctAction = $existing -and
            $existing.Actions.Execute -eq $powershellExe -and
            $existing.Actions.Arguments -eq $watchdogArguments -and
            $existing.Principal.UserId -in @($ownerName, $taskUser) -and
            $existing.Settings.Hidden
        $hasLogonTrigger = $existing -and @($existing.Triggers | Where-Object {
            $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'
        }).Count -gt 0
        if (!($correctAction -and $hasLogonTrigger)) {
            $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $watchdogArguments
            $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
                -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
            Register-ScheduledTask -TaskName $qbittorrentRestartTaskName -Action $action `
                -Principal $principal -Trigger $trigger -Settings $settings `
                -Description 'Keeps qBittorrent healthy in the signed-in TMS owner profile for safe magnet recovery.' `
                -Force | Out-Null
            Write-Host 'Configured persistent user-profile qBittorrent recovery.'
        }
    } catch {
        Write-Warning "Could not configure automatic qBittorrent recovery: $($_.Exception.Message)"
    }

    if (Test-TmsScriptProcess -ScriptPath $qbittorrentWatchdog) {
        return
    }

    if (Get-ScheduledTask -TaskName $qbittorrentRestartTaskName -ErrorAction SilentlyContinue) {
        try {
            Start-ScheduledTask -TaskName $qbittorrentRestartTaskName -ErrorAction Stop
            Write-Host 'Started the qBittorrent recovery watchdog.'
            return
        } catch {
        }
    }

    Start-TmsDetachedProcess -FilePath $powershellExe `
        -Arguments $watchdogArguments `
        -WorkingDirectory $projectRoot `
        -LogPath ($qbittorrentWatchdogLog + '.launcher.log')
    Write-Host 'Started the qBittorrent recovery watchdog process.'
}

function Test-TmsInteractiveSession {
    try {
        return ((Get-Process -Id $PID -ErrorAction Stop).SessionId -gt 0)
    } catch {
        return $false
    }
}

function Ensure-TmsFolderPickerBroker {
    $pickerScript = Join-Path $projectRoot 'scripts\tms-folder-picker-broker.ps1'
    if (!(Test-Path -LiteralPath $pickerScript -PathType Leaf)) {
        Write-Warning "The TMS folder picker broker was not found at $pickerScript."
        return
    }

    if (Test-TmsInteractiveSession) {
        $pickerCommand = 'wscript.exe //B //Nologo "{0}" "{1}"' -f (Join-Path $projectRoot 'scripts\run_hidden.vbs'), $pickerScript
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        try {
            New-ItemProperty -Path $runKey -Name 'TMS Folder Picker Broker' -Value $pickerCommand -PropertyType String -Force | Out-Null
        } catch {
            Write-Warning "Could not register the folder picker broker for sign-in: $($_.Exception.Message)"
        }
    }

    if (Test-TmsScriptProcess -ScriptPath $pickerScript) {
        Write-Host 'TMS folder picker broker is already running.'
        return
    }

    if (!(Test-TmsInteractiveSession)) {
        Write-Host 'Skipping folder picker broker start until an interactive desktop session is available.'
        return
    }

    Start-Process -FilePath 'wscript.exe' -ArgumentList ('//B //Nologo "{0}" "{1}"' -f (Join-Path $projectRoot 'scripts\run_hidden.vbs'), $pickerScript) -WindowStyle Hidden
    Write-Host 'Started the TMS folder picker broker.'
}

function Ensure-TmsTray {
    $trayLauncher = Join-Path $projectRoot 'scripts\start_tms_tray_hidden.vbs'
    $trayScript = Join-Path $projectRoot 'scripts\tms-tray.ps1'
    if (!(Test-Path -LiteralPath $trayLauncher -PathType Leaf)) {
        Write-Warning "The TMS tray launcher was not found at $trayLauncher."
        return
    }
    if (!(Test-Path -LiteralPath $trayScript -PathType Leaf)) {
        Write-Warning "The TMS tray script was not found at $trayScript."
        return
    }

    if (Test-TmsInteractiveSession) {
        $trayCommand = 'wscript.exe //B //Nologo "{0}"' -f $trayLauncher
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        try {
            New-ItemProperty -Path $runKey -Name 'TMS Tray' -Value $trayCommand -PropertyType String -Force | Out-Null
        } catch {
            Write-Warning "Could not register the TMS tray for sign-in: $($_.Exception.Message)"
        }
    }

    if (Test-TmsScriptProcess -ScriptPath $trayScript) {
        Write-Host 'TMS tray is already running.'
        return
    }

    if (!(Test-TmsInteractiveSession)) {
        Write-Host 'Skipping TMS tray start until an interactive desktop session is available.'
        return
    }

    Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', $trayLauncher) -WindowStyle Hidden
    Write-Host 'Started the TMS tray.'
}

function Get-TmsComponentProcessIds {
    param(
        [ValidateSet('frontend', 'backend')]
        [string]$Component
    )

    return @(Get-TmsProcessIds -ProjectRoot $projectRoot -BackendExe $backendExe `
            -FrontendLog $frontendLog -BackendLog $backendLog -DataRoot $dataRoot -Component $Component)
}

function Stop-TmsComponent {
    param(
        [ValidateSet('frontend', 'backend')]
        [string]$Component
    )

    Stop-TmsProcesses -ProjectRoot $projectRoot -BackendExe $backendExe `
        -FrontendLog $frontendLog -BackendLog $backendLog -DataRoot $dataRoot -Component $Component `
        -Label "existing $Component" | Out-Null

    if (@(Get-TmsComponentProcessIds -Component $Component).Count -eq 0) {
        return
    }

    # Background recovery must never wait for UAC. The boot supervisor owns
    # its children and can stop them using its existing service token.

    $survivors = @(Get-TmsComponentProcessIds -Component $Component)
    if ($survivors.Count -gt 0) {
        throw "Could not stop the existing $Component (PID $($survivors -join ', ')). Run kill_tms.ps1 in an elevated PowerShell window, then start TMS again."
    }
}

function Stop-TmsBackend {
    Stop-TmsComponent -Component 'backend'
}

function Stop-TmsFrontend {
    Stop-TmsComponent -Component 'frontend'
}

function Test-TmsBackendWatcherRunning {
    $backendDevScript = Join-Path $projectRoot 'scripts\backend-dev.ps1'
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        if ($process.Name -ieq 'cargo-watch.exe' -and $commandLine -like "*$projectRoot*") {
            return $true
        }
        if ($process.Name -ieq 'powershell.exe' -and $commandLine -like "*$backendDevScript*") {
            return $true
        }
        if ($process.Name -ieq 'cmd.exe' -and $commandLine -like '*backend:dev*') {
            return $true
        }
        if ($commandLine -like "*$backendLog*") {
            return $true
        }
    }
    return $false
}

function Test-TmsBackendHealthy {
    if (!(Test-TmsPortListening -Port $backendPort)) {
        return $false
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$backendPort/api/health" -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Start-TmsBackend {
    param(
        [string]$LogPath
    )

    if (Test-TmsBackendHealthy) {
        Write-Host 'Backend is already healthy; leaving the running auto-reload process alone.'
        return
    }

    if (Test-TmsBackendWatcherRunning) {
        Write-Host 'Backend auto-reload is already running; waiting for it to finish rebuilding.'
        $deadline = [DateTime]::UtcNow.AddMinutes(3)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-TmsBackendHealthy) {
                Write-Host 'Backend became healthy.'
                return
            }
            Start-Sleep -Seconds 2
        }
        Write-Host 'Backend auto-reload did not recover; replacing it.'
    }

    Stop-TmsBackend

    $backendDev = Join-Path $projectRoot 'scripts\backend-dev.ps1'
    Start-TmsDetachedProcess -FilePath 'powershell.exe' `
        -Arguments "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$backendDev`"" `
        -WorkingDirectory $projectRoot `
        -LogPath ($LogPath + '.launcher.log')
    Write-Host 'Started backend with auto-reload.'
}

function Get-TmsStaleScriptProcesses {
    # Long-lived elevated scripts keep their old code in memory. A process that
    # started before any of its scripts last changed must be replaced.
    param([string]$ScriptPath, [string[]]$DependencyPaths)

    $newest = @($ScriptPath) + $DependencyPaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
        ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTime } | Sort-Object -Descending | Select-Object -First 1
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'powershell.exe' -and [string]$_.CommandLine -like "*$ScriptPath*" -and
            $newest -and $_.CreationDate -and $_.CreationDate -lt $newest
    })
}

function Restart-TmsStaleSupervisor {
    $supervisorScript = Join-Path $projectRoot 'scripts\supervise-tms.ps1'
    $stale = @(Get-TmsStaleScriptProcesses -ScriptPath $supervisorScript -DependencyPaths @(
        (Join-Path $projectRoot 'scripts\tms-ports.ps1'),
        (Join-Path $projectRoot 'scripts\tms-paths.ps1'),
        (Join-Path $projectRoot 'scripts\tms-hidden.ps1')))
    if ($stale.Count -eq 0) {
        return
    }

    # The launcher often runs inside the supervisor itself, so a detached helper
    # stops it and starts the current script after this launcher returns.
    $ids = ($stale | ForEach-Object { $_.ProcessId }) -join ','
    $helper = "Start-Sleep -Seconds 3; foreach (`$id in @($ids)) { Stop-Process -Id `$id -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3; " +
        "Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory '$projectRoot' -ArgumentList '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisorScript`"'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
    Start-TmsDetachedProcess -FilePath 'powershell.exe' `
        -Arguments "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded" `
        -WorkingDirectory $projectRoot
    Write-Host "Replacing outdated TMS supervisor ($ids)."
}

function Ensure-TmsSupervisor {
    $supervisorScript = Join-Path $projectRoot 'scripts\supervise-tms.ps1'
    $existing = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'powershell.exe' -and [string]$_.CommandLine -like "*$supervisorScript*"
    })
    if ($existing.Count -gt 0) {
        return
    }

    foreach ($taskName in $startupTaskNames) {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            try {
                Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
                Write-Host "Started the TMS supervisor task ($taskName)."
                return
            } catch {
            }
        }
    }

    Start-TmsDetachedProcess -FilePath 'powershell.exe' `
        -Arguments "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisorScript`"" `
        -WorkingDirectory $projectRoot
    Write-Host 'Started the TMS supervisor process.'
}

function Start-TmsDetachedProcess {
    param(
        [string]$FilePath,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$LogPath = ''
    )

    . (Join-Path $projectRoot 'scripts\tms-hidden.ps1')
    [void](Start-TmsHiddenProcess -FilePath $FilePath -Arguments $Arguments `
        -WorkingDirectory $WorkingDirectory -LogPath $LogPath)
}

function Publish-TmsFrontendRelease {
    $publisher = Join-Path $projectRoot 'scripts\publish-production-frontend.ps1'
    $release = & $publisher -ProjectRoot $projectRoot
    if ($LASTEXITCODE -ne 0 -or !$release) {
        throw 'Could not stage the completed frontend build as an immutable release.'
    }
    return ([string]$release | Select-Object -Last 1).Trim()
}

function Start-TmsFrontendRelease {
    param(
        [string]$ReleaseRoot,
        [string]$LogPath
    )

    $server = Join-Path $projectRoot 'scripts\start-production-frontend.ps1'
    Start-TmsDetachedProcess -FilePath 'powershell.exe' `
        -Arguments "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$server`" -ProjectRoot `"$projectRoot`" -ReleaseRoot `"$ReleaseRoot`" -LogPath `"$LogPath`" -Port $frontendPort -BindAddress $frontendBindAddress" `
        -WorkingDirectory $projectRoot `
        -LogPath ($LogPath + '.launcher.log')
}

function Start-TmsFrontend {
    param(
        [string]$LogPath
    )

    $listening = Test-TmsPortListening -Port $frontendPort
    if ($listening) {
        try {
            $rootResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$frontendPort/" -TimeoutSec 5
            $manifestResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$frontendPort/manifest.webmanifest" -TimeoutSec 5
            if ($rootResponse.StatusCode -eq 200 -and $manifestResponse.StatusCode -eq 200) {
                Write-Host 'Frontend is already healthy; leaving the running production server alone.'
                return
            }
        } catch {
        }
        Write-Host 'Frontend is already listening; restarting to pick up the latest code.'
    }

    Stop-TmsFrontend

    # Vinext normally falls back to the next port when the previous frontend has
    # not quite released 3000. That leaves this launcher waiting on 3000 while
    # the new app is actually running on 3001. Wait for the intended port to be
    # released, then require Vinext to use it so startup has one reliable URL.
    $releaseDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Test-TmsPortListening -Port $frontendPort) {
        if ([DateTime]::UtcNow -ge $releaseDeadline) {
            throw "Port $frontendPort is still in use after stopping TMS. Run kill_tms.ps1 in an elevated PowerShell window, then start TMS again."
        }
        Start-Sleep -Milliseconds 250
    }

    $releasesRoot = Join-Path $dataRoot 'frontend-releases'
    $existingRelease = Get-ChildItem -LiteralPath $releasesRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Where-Object {
            (Test-Path (Join-Path $_.FullName 'dist\client\index.html')) -and
            (Test-Path (Join-Path $_.FullName 'dist\server\index.js')) -and
            (Test-Path (Join-Path $_.FullName 'dist\server\ssr\index.js'))
        } | Select-Object -First 1
    if ($existingRelease) {
        Start-TmsFrontendRelease -ReleaseRoot $existingRelease.FullName -LogPath $LogPath
        Write-Host 'Started existing production frontend release without rebuilding.'
        return
    }
    Write-Host 'No published frontend release exists; building the first release...'
    # Windows PowerShell wraps native stderr as PowerShell error records. Vinext
    # writes ordinary build notices (including rewrite information) to stderr,
    # so ErrorActionPreference=Stop used to abort an otherwise successful build
    # before the production server could start.
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & npm.cmd run build *>> $LogPath
        $frontendBuildExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($frontendBuildExitCode -ne 0) {
        throw "Frontend production build failed. Check $LogPath"
    }

    $releaseRoot = Publish-TmsFrontendRelease
    Start-TmsFrontendRelease -ReleaseRoot $releaseRoot -LogPath $LogPath
    Write-Host 'Started optimized production frontend.'
}

function Start-TmsFrontendWatcher {
    $watcherScript = Join-Path $projectRoot 'scripts\watch-production-frontend.ps1'
    $existingWatcher = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -like "*$watcherScript*"
    })
    $staleWatcher = @(Get-TmsStaleScriptProcesses -ScriptPath $watcherScript -DependencyPaths @(
        (Join-Path $projectRoot 'scripts\tms-ports.ps1'),
        (Join-Path $projectRoot 'scripts\tms-hidden.ps1'),
        (Join-Path $projectRoot 'scripts\frontend-source-stamp.ps1')))
    foreach ($process in $staleWatcher) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped outdated production frontend watcher ($($process.ProcessId))."
    }
    if ($staleWatcher.Count -gt 0) {
        Start-Sleep -Seconds 1
        $existingWatcher = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$watcherScript*" })
    }
    if ($existingWatcher.Count -gt 0) {
        Write-Host 'Production frontend watcher is already running.'
        return
    }

    Start-TmsDetachedProcess -FilePath 'powershell.exe' `
        -Arguments "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watcherScript`" -ProjectRoot `"$projectRoot`" -LogPath `"$frontendWatcherLog`" -Port $frontendPort -BindAddress $frontendBindAddress" `
        -WorkingDirectory $projectRoot `
        -LogPath ($frontendWatcherLog + '.launcher.log')
    Write-Host 'Started production frontend rebuild watcher.'
}

if (!$frontendIsLoopbackOnly) {
    Enable-TmsFirewallRule -RuleName $firewallRuleName -Port $frontendPort
}

Enable-TmsFirewallRule -RuleName $backendFirewallRuleName -Port $backendPort -RemoteAddresses @('100.64.0.0/10', 'fd7a:115c:a1e0::/48')

function Wait-TmsListener {
    param(
        [int]$Port,
        [string]$Name,
        [string]$LogPath,
        [int]$TimeoutMs = 600000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TmsPortListening -Port $Port) {
            Write-Host "$Name is listening on port $Port."
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name did not start listening on port $Port. Check $LogPath"
}

Ensure-QbittorrentRestartTask
# Bring the private API up first. A production frontend build can take a while,
# and it must not delay or hide a backend startup failure.
if (!$FrontendOnly) {
    Start-TmsBackend -LogPath $backendLog
    Wait-TmsListener -Port $backendPort -Name 'Backend' -LogPath $backendLog -TimeoutMs 600000
}

if (!$BackendOnly) {
    Start-TmsFrontend -LogPath $frontendLog

    Write-Host "TMS services are launching at http://localhost:$frontendPort"
    Wait-TmsListener -Port $frontendPort -Name 'Frontend' -LogPath $frontendLog -TimeoutMs 300000
}
if (!$BackendOnly -or (Test-TmsPortListening -Port $frontendPort)) {
    Start-TmsFrontendWatcher
}
Restart-TmsStaleSupervisor
Ensure-TmsSupervisor
Ensure-TmsFolderPickerBroker
Ensure-TmsTray

# PWA installation requires HTTPS. Tailscale Serve exposes this private frontend
# at the device hostname without opening it to the public internet.
if (Test-Path -LiteralPath $tailscaleExe) {
    $serveProcess = Start-Process -FilePath $tailscaleExe -ArgumentList @('serve', '--bg', '--yes', $frontendPort) -PassThru -WindowStyle Hidden
    if (!$serveProcess.WaitForExit(15000)) {
        Stop-Process -Id $serveProcess.Id -Force
        Write-Warning 'TMS started, but Tailscale HTTPS setup timed out. Enable HTTPS Certificates in the tailnet DNS settings, then start TMS again.'
    } elseif ($serveProcess.ExitCode -ne 0) {
        Write-Warning 'TMS started, but Tailscale Serve could not be configured for HTTPS access.'
    } elseif ($tailscaleDnsName) {
        Write-Host "  Install on phone: https://${tailscaleDnsName}"
    }
} else {
    Write-Warning 'Tailscale was not found; TMS cannot be installed as a phone PWA until it is served over HTTPS.'
}

if ($frontendIsLoopbackOnly) {
    return
}

$lanAddresses = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.PrefixOrigin -in @('Dhcp', 'Manual') -and
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.IPAddress -notin $tailscaleAddresses
        } |
        Select-Object -ExpandProperty IPAddress
)
foreach ($address in $lanAddresses) {
    Write-Host "  Network: http://${address}:$frontendPort"
}
foreach ($address in @($tailscaleAddresses | Where-Object { $_ -notmatch ':' })) {
    Write-Host "  Tailscale: http://${address}:$frontendPort"
}
if ($tailscaleDnsName) {
    Write-Host "  Tailscale: http://${tailscaleDnsName}:$frontendPort"
}
