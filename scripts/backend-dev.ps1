$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
Hide-TmsConsoleWindow

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $projectRoot

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

& (Join-Path $PSScriptRoot 'backend-run-loop.ps1')
