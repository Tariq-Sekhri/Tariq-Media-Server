# Keep media and runtime state outside the source checkout.
$relocationJournal = Join-Path $env:ProgramData 'TMS\Relocation\pending.json'
if (Test-Path -LiteralPath $relocationJournal) {
    throw 'TMS relocation was interrupted. Run scripts/move-tms.ps1 -Recover as administrator before starting TMS.'
}
$libraryRoot = if ($env:TMS_LIBRARY_ROOT) { $env:TMS_LIBRARY_ROOT } else { 'C:\TariqsMediaServer' }
$dataRoot = Join-Path $libraryRoot '.tms-data'
. (Join-Path $PSScriptRoot 'tms-ports.ps1')
