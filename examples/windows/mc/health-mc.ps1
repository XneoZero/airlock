# Health probe: is anything listening on the Minecraft port?
$conn = Get-NetTCPConnection -LocalPort 25565 -State Listen -ErrorAction SilentlyContinue
if ($null -ne $conn) {
    Write-Output 'listening'
    exit 0
}
Write-Output 'not listening'
exit 1