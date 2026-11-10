# Stop the app: the pid file lives in the app root (deployer.json sets "cwd": "root").
# Replace <app> with the app id from deployer.json.
$ErrorActionPreference = 'Continue'

$pidFile = 'app.pid'
if (-not (Test-Path $pidFile)) {
    Write-Output 'no pid file, nothing to stop'
    exit 0
}

$raw = (Get-Content $pidFile -Raw).Trim()
$target = 0
if (-not [int]::TryParse($raw, [ref]$target) -or $target -le 0) {
    Write-Output "invalid pid file content: '$raw'"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}

$process = Get-Process -Id $target -ErrorAction SilentlyContinue
if ($null -eq $process) {
    Write-Output "pid $target not running"
} else {
    Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Write-Output "stopped pid $target"
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue

# Best effort: clean up the scheduled task so they do not pile up.
# '>nul' is cmd syntax and errors in PowerShell; use a PowerShell redirect.
schtasks /end /tn airlock-<app>-start 2>$null | Out-Null