function Get-TmsAndroidSdkRoot {
    $androidSdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    if (!(Test-Path -LiteralPath $androidSdk)) {
        throw 'Android SDK not found. Install Android Studio or set ANDROID_HOME.'
    }
    $env:ANDROID_HOME = $androidSdk
    return $androidSdk
}

function Get-TmsAdbPath {
    $androidSdk = Get-TmsAndroidSdkRoot
    $adbPath = Join-Path $androidSdk 'platform-tools\adb.exe'
    if (!(Test-Path -LiteralPath $adbPath)) {
        throw "adb not found at $adbPath"
    }
    return $adbPath
}

function Get-TmsConnectedAndroidDevices {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AdbPath
    )

    $lines = & $AdbPath devices -l 2>&1
    $devices = @()
    foreach ($line in $lines) {
        if ($line -match '^(?<serial>\S+)\s+device\b') {
            $devices += $Matches.serial
        }
    }
    return $devices
}

function Get-TmsTailscaleServerUrl {
    $tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'
    if (!(Test-Path -LiteralPath $tailscaleExe)) {
        return $null
    }

    try {
        $tailscaleStatus = & $tailscaleExe status --json | ConvertFrom-Json
        $tailscaleDnsName = ([string]$tailscaleStatus.Self.DNSName).TrimEnd('.')
        if ($tailscaleDnsName) {
            return "https://$tailscaleDnsName"
        }
    } catch {
        Write-Warning "Could not read Tailscale status: $_"
    }

    return $null
}

function Enable-TmsTailscaleServe {
    param(
        [int]$Port = 3000
    )

    $tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'
    if (!(Test-Path -LiteralPath $tailscaleExe)) {
        Write-Warning 'Tailscale was not found; the mobile app needs HTTPS via Tailscale Serve.'
        return $false
    }

    $serveProcess = Start-Process -FilePath $tailscaleExe -ArgumentList @('serve', '--bg', '--yes', $Port) -PassThru -WindowStyle Hidden
    if (!$serveProcess.WaitForExit(15000)) {
        Stop-Process -Id $serveProcess.Id -Force
        Write-Warning 'Tailscale HTTPS setup timed out. Enable HTTPS Certificates in the tailnet DNS settings.'
        return $false
    }
    if ($serveProcess.ExitCode -ne 0) {
        Write-Warning 'Tailscale Serve could not be configured for HTTPS access.'
        return $false
    }

    return $true
}

function Read-TmsKeystoreProperties {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $keystorePropertiesPath = Join-Path $ProjectRoot 'android\keystore.properties'
    if (!(Test-Path -LiteralPath $keystorePropertiesPath)) {
        throw "Missing android/keystore.properties. Copy android/keystore.properties.example and fill in your upload key."
    }

    $properties = @{}
    foreach ($rawLine in Get-Content -LiteralPath $keystorePropertiesPath) {
        $line = $rawLine.Trim()
        if (!$line -or $line.StartsWith('#')) {
            continue
        }
        $separatorIndex = $line.IndexOf('=')
        if ($separatorIndex -lt 1) {
            continue
        }
        $name = $line.Substring(0, $separatorIndex).Trim()
        $value = $line.Substring($separatorIndex + 1).Trim()
        $properties[$name] = $value
    }

    foreach ($requiredName in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
        if (!$properties.ContainsKey($requiredName) -or [string]::IsNullOrWhiteSpace($properties[$requiredName])) {
            throw "android/keystore.properties is missing $requiredName."
        }
    }

    $storeFilePath = $properties.storeFile
    if (!(Test-Path -LiteralPath $storeFilePath)) {
        throw "Keystore file not found at $storeFilePath"
    }

    return [pscustomobject]@{
        PropertiesPath = $keystorePropertiesPath
        StoreFile = (Resolve-Path -LiteralPath $storeFilePath).Path
        StorePassword = $properties.storePassword
        KeyAlias = $properties.keyAlias
        KeyPassword = $properties.keyPassword
    }
}

function Wait-TmsHttpReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        } catch {
        }
        Start-Sleep -Milliseconds 500
    }

    return $false
}
