# Keep media and runtime state outside the source checkout.
$libraryRoot = if ($env:TMS_LIBRARY_ROOT) { $env:TMS_LIBRARY_ROOT } else { 'C:\TariqsMediaServer' }
$dataRoot = Join-Path $libraryRoot '.tms-data'
. (Join-Path $PSScriptRoot 'tms-ports.ps1')
