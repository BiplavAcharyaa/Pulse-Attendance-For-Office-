<#
.SYNOPSIS
  Type-checks and builds PULSE (main process, host service and both web UIs).
#>
. "$PSScriptRoot\_common.ps1"
Set-Location $script:Root
Assert-Node
Write-Step 'Type-checking'
Invoke-Checked 'typecheck' { npm run typecheck }
Write-Step 'Building'
Invoke-Checked 'build' { npm run build }
Write-Ok 'Build finished.'
