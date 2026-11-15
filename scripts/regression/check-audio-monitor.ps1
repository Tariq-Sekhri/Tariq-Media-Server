$ErrorActionPreference='Stop'
$output=Join-Path $PWD 'private/audio-monitor-self-check.jsonl'
$monitor=Join-Path $PSScriptRoot 'monitor-audio.ps1'
$child=Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"'+$monitor+'"'),'-Seconds','30','-OutputPath',('"'+$output+'"')) -PassThru -WindowStyle Hidden
try {
    $deadline=(Get-Date).AddSeconds(10)
    while((Get-Date) -lt $deadline){if((Test-Path $output) -and ((Get-Content -Raw $output).Contains('"ready"'))){break};Start-Sleep -Milliseconds 100}
    $bytes=[System.Net.WebClient]::new().DownloadData('http://127.0.0.1:3100/media/synthetic-tone.wav')
    $stream=[System.IO.MemoryStream]::new($bytes,$false)
    $player=[System.Media.SoundPlayer]::new($stream)
    $player.PlaySync()
    $player.Dispose();$stream.Dispose()
    if(!(Get-Content -Raw $output).Contains('"tone"')){throw 'Loopback self-check did not detect the known host tone'}
    Write-Output 'PASS: host loopback detects the generated fixture tone'
} finally {if(!$child.HasExited){Stop-Process -Id $child.Id}}
