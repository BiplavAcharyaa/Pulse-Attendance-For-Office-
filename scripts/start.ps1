<#
.SYNOPSIS
  Builds if necessary and launches PULSE.
.PARAMETER DataDir
  Optional data folder. Defaults to %APPDATA%\PULSE\data.
.PARAMETER Rebuild
  Force a rebuild before launching.
#>
param(
    [string]$DataDir,
    [switch]$Rebuild
)
. "$PSScriptRoot\_common.ps1"
Set-Location $script:Root
Assert-Node

if (-not (Test-Path (Join-Path $script:Root 'node_modules'))) {
    Write-Step 'Dependencies are missing - running setup first'
    & "$PSScriptRoot\setup.ps1"
}
if ($Rebuild -or -not (Test-Path (Join-Path $script:Root 'dist\main\main.js')) -or -not (Test-Path (Join-Path $script:Root 'dist-renderer\index.html'))) {
    Write-Step 'Building'
    Invoke-Checked 'npm run build' { npm run build }
}
if ($DataDir) { $env:PULSE_DATA_DIR = $DataDir }
Write-Step "Starting PULSE (data folder: $(Get-PulseDataDir))"
Invoke-Checked 'electron' { npx electron . }
