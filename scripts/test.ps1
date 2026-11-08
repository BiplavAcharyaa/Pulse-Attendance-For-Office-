<#
.SYNOPSIS
  Runs the whole automated test suite: type-check, unit/integration tests and the Electron end-to-end self-test.
.PARAMETER SkipSelfTest
  Skip the Electron self-test (it opens real windows for about a minute).
#>
param([switch]$SkipSelfTest)
. "$PSScriptRoot\_common.ps1"
Set-Location $script:Root
Assert-Node

Write-Step 'Type-checking'
Invoke-Checked 'typecheck' { npm run typecheck }

Write-Step 'Building'
Invoke-Checked 'build' { npm run build }

Write-Step 'Unit and integration tests (vitest)'
Invoke-Checked 'vitest' { npm test }

if (-not $SkipSelfTest) {
    Write-Step 'Electron end-to-end self-test (uses a temporary data folder)'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("pulse-selftest-" + [Guid]::NewGuid().ToString('N'))
    $env:PULSE_DATA_DIR = $tmp
    try {
        Invoke-Checked 'selftest' { npx electron . --selftest }
        Write-Ok "Screenshots: $(Join-Path $script:Root 'selftest-output')"
    } finally {
        Remove-Item Env:\PULSE_DATA_DIR -ErrorAction SilentlyContinue
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}
Write-Ok 'All checks passed.'
