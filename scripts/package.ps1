<#
.SYNOPSIS
  Builds a Windows installer and portable exe into .\release using electron-builder.
#>
. "$PSScriptRoot\_common.ps1"
Set-Location $script:Root
Assert-Node
Write-Step 'Building Windows packages'
Invoke-Checked 'electron-builder' { npm run dist:win }
Write-Ok "Packages written to $(Join-Path $script:Root 'release')"
