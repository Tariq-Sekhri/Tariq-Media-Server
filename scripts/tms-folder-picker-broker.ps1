$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'tms-hidden.ps1')
Hide-TmsConsoleWindow

$requestRoot = 'C:\Users\Public\Documents\TMS Folder Picker'
New-Item -ItemType Directory -Force -Path $requestRoot | Out-Null
$brokerStarted = Get-Date
$readyPath = Join-Path $requestRoot 'broker.ready'

function Update-BrokerReady {
    [System.IO.File]::WriteAllText(
        $readyPath,
        [DateTime]::UtcNow.ToString('O'),
        [System.Text.Encoding]::UTF8)
}

Update-BrokerReady

while ($true) {
    Update-BrokerReady
    $request = Get-ChildItem -LiteralPath $requestRoot -Filter 'tms-folder-picker-*.ps1' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $brokerStarted } |
        Sort-Object LastWriteTime |
        Select-Object -First 1

    if (-not $request) {
        Start-Sleep -Milliseconds 250
        continue
    }

    $runningPath = [System.IO.Path]::ChangeExtension($request.FullName, '.running.ps1')
    try {
        Move-Item -LiteralPath $request.FullName -Destination $runningPath -ErrorAction Stop
    } catch {
        Start-Sleep -Milliseconds 100
        continue
    }

    $resultPath = $request.FullName.Substring(0, $request.FullName.Length - 4) + '.txt'
    try {
        & (Join-Path $PSHOME 'powershell.exe') `
            -NoProfile `
            -STA `
            -WindowStyle Hidden `
            -ExecutionPolicy Bypass `
            -File $runningPath `
            $resultPath
        if ($LASTEXITCODE -ne 0 -and !(Test-Path -LiteralPath "$resultPath.error")) {
            throw "Folder picker process exited with code $LASTEXITCODE."
        }
    } catch {
        [System.IO.File]::WriteAllText(
            "$resultPath.error",
            ($_ | Out-String),
            [System.Text.Encoding]::UTF8)
    } finally {
        Remove-Item -LiteralPath $runningPath -Force -ErrorAction SilentlyContinue
    }
}
