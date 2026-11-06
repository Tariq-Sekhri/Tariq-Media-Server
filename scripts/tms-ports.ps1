# Port checks for TMS services.
# Windows' TCP table (Get-NetTCPConnection and netstat) can stop listing live
# listeners, e.g. while a VPN filter driver is active. Every check therefore
# falls back to an actual loopback connection, and owner lookups fall back to
# the TMS server processes themselves.

function Test-TmsPortListening {
    param([int]$Port)
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1) {
        return $true
    }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.ConnectAsync('127.0.0.1', $Port)
        return [bool]($connect.Wait(1000) -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-TmsPortOwnerIds {
    param([int]$Port)
    $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Where-Object OwningProcess -gt 0 | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($ids.Count -or !(Test-TmsPortListening -Port $Port)) {
        return $ids
    }
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $candidates = switch ($Port) {
        3000 { $processes | Where-Object { $_.Name -ieq 'node.exe' -and [string]$_.CommandLine -like '*serve-production-frontend.mjs*' } }
        8787 { $processes | Where-Object { $_.Name -ieq 'tms-server.exe' } }
        default { @() }
    }
    return @($candidates | Select-Object -ExpandProperty ProcessId -Unique)
}
