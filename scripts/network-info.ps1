<#
.SYNOPSIS
  Shows the addresses phones should use and checks that PULSE's ports are listening and allowed by the firewall.
#>
param([int]$HttpsPort = 8443, [int]$SetupPort = 8081)
. "$PSScriptRoot\_common.ps1"

Write-Step 'Private IPv4 addresses on this PC'
$addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' }
foreach ($a in $addrs) {
    Write-Host ("    {0,-16} {1}" -f $a.IPAddress, $a.InterfaceAlias)
    Write-Host ("        phone page : https://{0}:{1}" -f $a.IPAddress, $HttpsPort)
    Write-Host ("        cert setup : http://{0}:{1}" -f $a.IPAddress, $SetupPort)
}
if (-not $addrs) { Write-Warn2 'No private LAN address found. Connect this PC to the office network.' }

Write-Step 'Listening ports'
foreach ($p in @($HttpsPort, $SetupPort)) {
    $l = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
    if ($l) { Write-Ok "TCP $p is listening on $($l[0].LocalAddress)" } else { Write-Warn2 "TCP $p is not listening (is PULSE running?)" }
}

Write-Step 'Firewall rules'
foreach ($n in @('PULSE phone HTTPS', 'PULSE phone setup page')) {
    $r = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
    if ($r) { Write-Ok "$n : $($r.Enabled), profile $($r.Profile)" } else { Write-Warn2 "$n : missing - run scripts\firewall.ps1 as Administrator" }
}
