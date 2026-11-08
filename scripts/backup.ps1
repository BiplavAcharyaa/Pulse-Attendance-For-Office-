<#
.SYNOPSIS
  Copies the PULSE data folder to a backup location (for example a USB drive or network share).
.DESCRIPTION
  Stop PULSE first for a perfectly consistent copy; PULSE also writes its own automatic backups under <data>\backups.
  The copy is read-only with respect to the source - nothing is changed or deleted in the data folder.
  NOTE: host-secrets.json is protected by Windows for the signed-in user of THIS PC. A backup restored on another
  PC/user cannot decrypt it; see README section 8 "Restoring on a different PC or Windows user".
.PARAMETER Destination  Folder that will receive a timestamped sub-folder.
.PARAMETER DataDir      Source data folder (defaults to %APPDATA%\PULSE\data or $env:PULSE_DATA_DIR).
#>
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$DataDir
)
. "$PSScriptRoot\_common.ps1"
if (-not $DataDir) { $DataDir = Get-PulseDataDir }
if (-not (Test-Path $DataDir)) { throw "Data folder not found: $DataDir" }

if (Get-Process -Name 'PULSE' -ErrorAction SilentlyContinue) {
    Write-Warn2 'PULSE is running. The copy is still safe (PULSE writes files atomically) but may miss the last few seconds.'
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $Destination "pulse-data-$stamp"
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $DataDir '*') -Destination $target -Recurse -Force -Exclude 'tmp'
$count = (Get-ChildItem -Recurse -File $target | Measure-Object).Count
Write-Ok "Copied $count files to $target"

# Verify: every file exists with the same size.
$bad = 0
Get-ChildItem -Recurse -File $DataDir | ForEach-Object {
    $rel = $_.FullName.Substring($DataDir.Length).TrimStart('\')
    $copy = Join-Path $target $rel
    if ((Test-Path $copy) -and ((Get-Item $copy).Length -ne $_.Length)) { $bad++; Write-Warn2 "Size differs (file changed while copying?): $rel" }
}
if ($bad -eq 0) { Write-Ok 'Backup verified (all file sizes match).' } else { Write-Warn2 "$bad file(s) changed during the copy - run the backup again with PULSE closed." }
