<#
.SYNOPSIS
  Opens (or removes) the two Windows Firewall rules phones need. Run in an elevated PowerShell.
.DESCRIPTION
  Phones connect to TCP 8443 (HTTPS attendance) and, for the one-time certificate setup page, TCP 8081 (HTTP).
  Rules are limited to the local subnet and to the Private network profile. Nothing is opened to the internet.
.PARAMETER HttpsPort  Default 8443 (Settings -> Network in the app).
.PARAMETER SetupPort  Default 8081.
.PARAMETER Remove     Delete the rules instead of creating them.
.PARAMETER AllProfiles Also allow the Domain and Public profiles (use only if the office network is classified as Public).
#>
param(
    [int]$HttpsPort = 8443,
    [int]$SetupPort = 8081,
    [switch]$Remove,
    [switch]$AllProfiles
)
. "$PSScriptRoot\_common.ps1"

if (-not (Test-IsAdmin)) { throw 'Please run this script from an elevated (Administrator) PowerShell.' }

$names = @('PULSE phone HTTPS', 'PULSE phone setup page')
foreach ($n in $names) { Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
if ($Remove) { Write-Ok 'PULSE firewall rules removed.'; return }

$fwProfile = if ($AllProfiles) { 'Any' } else { 'Private' }
New-NetFirewallRule -DisplayName 'PULSE phone HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort `
    -RemoteAddress LocalSubnet -Profile $fwProfile -Description 'PULSE attendance: phones on the office LAN' | Out-Null
New-NetFirewallRule -DisplayName 'PULSE phone setup page' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $SetupPort `
    -RemoteAddress LocalSubnet -Profile $fwProfile -Description 'PULSE attendance: one-time certificate page' | Out-Null
Write-Ok "Allowed TCP $HttpsPort and $SetupPort from the local subnet (profile: $fwProfile)."

$conn = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' }
foreach ($c in $conn) {
    if ($c.NetworkCategory -eq 'Public' -and -not $AllProfiles) {
        Write-Warn2 "Adapter '$($c.InterfaceAlias)' is classified Public, so the Private-profile rules will not apply."
        Write-Warn2 "Either change it to Private (Settings -> Network) or re-run with -AllProfiles."
    }
}
