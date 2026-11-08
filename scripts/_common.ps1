# Shared helpers for the PULSE PowerShell scripts. Dot-source with:  . "$PSScriptRoot\_common.ps1"
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Root = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function Assert-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js was not found. Install Node.js 22 LTS or newer from https://nodejs.org and re-open PowerShell."
    }
    $major = [int](& node -p "process.versions.node.split('.')[0]")
    if ($major -lt 22) { throw "Node.js $major found; PULSE needs Node.js 22 or newer." }
    Write-Ok "Node.js $(& node -v), npm $(& npm -v)"
}

function Invoke-Checked([string]$What, [scriptblock]$Block) {
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

function Get-PulseDataDir {
    if ($env:PULSE_DATA_DIR) { return $env:PULSE_DATA_DIR }
    return (Join-Path $env:APPDATA 'PULSE\data')
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
