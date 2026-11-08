<#
.SYNOPSIS
  Installs dependencies and builds PULSE. Run once after copying the project to the office PC.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
#>
. "$PSScriptRoot\_common.ps1"
Set-Location $script:Root

Write-Step 'Checking prerequisites'
Assert-Node

Write-Step 'Installing dependencies (npm ci)'
if (Test-Path (Join-Path $script:Root 'package-lock.json')) {
    Invoke-Checked 'npm ci' { npm ci --no-audit --no-fund }
} else {
    Invoke-Checked 'npm install' { npm install --no-audit --no-fund }
}

Write-Step 'Building (TypeScript + Vite)'
Invoke-Checked 'npm run build' { npm run build }

Write-Ok 'Done. Start PULSE with:  .\scripts\start.ps1'
Write-Ok 'Allow phones through Windows Firewall (once, as Administrator):  .\scripts\firewall.ps1'
