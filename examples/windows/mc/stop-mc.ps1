# Stop Minecraft.
#
# This box runs Minecraft through Task Scheduler with no console session, so
# "taskkill" without /F has no window to post WM_CLOSE to and the JVM never runs
# its shutdown hook. We still try briefly, then force.
#
# Consequence: the last few seconds of chunk writes can be lost. For a real
# server enable RCON (enable-rcon=true, rcon.password=...) and send "stop" over
# RCON instead of killing the process.
$ErrorActionPreference = 'Continue'
$port = 25565

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($null -eq $conn) {
    Write-Output "no listener on $port, nothing to stop"
} else {
    foreach ($c in $conn) {
        $targetPid = $c.OwningProcess
        & "$env:SystemRoot\System32\taskkill.exe" /PID $targetPid 2>&1 | Out-Null
        $gone = $false
        for ($i = 0; $i -lt 3; $i++) {
            Start-Sleep -Seconds 1
            if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { $gone = $true; break }
        }
        if ($gone) {
            Write-Output "stopped pid $targetPid (graceful)"
        } else {
            Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
            Write-Output "stopped pid $targetPid (forced)"
        }
    }
}
schtasks /end /tn airlock-mc-start 2>$null | Out-Null