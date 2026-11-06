$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
. (Join-Path $projectRoot 'scripts\tms-paths.ps1')
$jsonPath = Join-Path $dataRoot 'yt-dlp-jobs.json'

if (-not (Test-Path $jsonPath)) {
    Write-Host "No yt-dlp jobs found." -ForegroundColor Red
    exit 1
}

$jobsData = Get-Content $jsonPath -Raw | ConvertFrom-Json
$latestJob = $jobsData.jobs[-1]

if (-not $latestJob) {
    Write-Host "No yt-dlp jobs found in the queue." -ForegroundColor Red
    exit 1
}

$status = $latestJob.status
$progressPercent = [math]::Round($latestJob.progress * 100, 2)
$itemCount = $latestJob.item_count
$currentItem = $latestJob.current_item
$title = $latestJob.title

$stagingDir = Join-Path $dataRoot "yt-dlp\staging\$($latestJob.id)"
if (Test-Path $stagingDir) {
    $stdoutFile = Join-Path $stagingDir "stdout.log"
    if (Test-Path $stdoutFile) {
        $recentLines = Get-Content $stdoutFile -Tail 80 -ErrorAction SilentlyContinue
        if ($recentLines) {
            foreach ($line in $recentLines) {
                if ($line -match '\[download\]\s+Downloading item\s+(\d+)\s+of\s+(\d+)') {
                    $curIdx = [int]$matches[1]
                    $totIdx = [int]$matches[2]
                    $downloadedCount = $curIdx
                    $progressPercent = [math]::Round(($curIdx / $totIdx) * 100, 2)
                }
                if ($line -match '\[download\]\s+[^:]+:\s+(.+?)\s+has already been recorded in the archive') {
                    $currentItem = $matches[1]
                }
            }
        }
    }
}

Write-Host "=== YT-DLP Status ===" -ForegroundColor Cyan
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "Playlist: $($title) ($itemCount items)"
Write-Host "Status: $($status)"

if ($status -eq "running") {
    Write-Host "Progress: $($progressPercent)% ($downloadedCount / $itemCount processed)"
    if ($currentItem) {
        Write-Host "Current song: $currentItem"
    }
} elseif ($status -eq "interrupted" -or $status -eq "failed" -or $status -eq "complete") {
    if ($latestJob.error) {
        Write-Host "Message: $($latestJob.error)" -ForegroundColor Yellow
    }
}

if (Test-Path $stagingDir) {
    $files = Get-ChildItem -Path $stagingDir -Recurse -File | Where-Object { $_.Name -notmatch '\.(log|part|ytdl)$' -and $_.Name -ne '.archive.txt' } | Sort-Object LastWriteTime
    $fileCount = $files.Count
    Write-Host "Files currently in staging directory: $fileCount"
    
    if ($status -eq "running" -and $fileCount -gt 1) {
        $firstTime = $files[0].LastWriteTime
        $lastTime = $files[-1].LastWriteTime
        $timeSpan = $lastTime - $firstTime
        $avgSeconds = $timeSpan.TotalSeconds / ($fileCount - 1)
        
        $remainingItems = $itemCount - $fileCount
        if ($remainingItems -lt 0) { $remainingItems = 0 }
        
        $remainingSeconds = $remainingItems * $avgSeconds
        $etaSpan = [TimeSpan]::FromSeconds($remainingSeconds)
        
        $etaFormatted = ""
        if ($etaSpan.Days -gt 0) { $etaFormatted += "$($etaSpan.Days)d " }
        if ($etaSpan.Hours -gt 0) { $etaFormatted += "$($etaSpan.Hours)h " }
        if ($etaSpan.Minutes -gt 0) { $etaFormatted += "$($etaSpan.Minutes)m " }
        $etaFormatted += "$($etaSpan.Seconds)s"
        
        $avgFormatted = [math]::Round($avgSeconds, 2)
        Write-Host "Average time per item: $avgFormatted seconds"
        Write-Host "Estimated Time Remaining (ETA): $etaFormatted" -ForegroundColor Magenta
    }
}

$ytProcess = Get-Process yt-dlp -ErrorAction SilentlyContinue
if ($ytProcess) {
    $pids = ($ytProcess | Select-Object -ExpandProperty Id) -join ", "
    Write-Host "yt-dlp process is ACTIVE (PID(s): $pids)" -ForegroundColor Green
} else {
    if ($status -eq "running") {
        Write-Host "WARNING: Job status is 'running' but yt-dlp process is NOT active! Process interrupted." -ForegroundColor Red
    } else {
        Write-Host "yt-dlp process is NOT active." -ForegroundColor Gray
    }
}
Write-Host "=====================" -ForegroundColor Cyan
