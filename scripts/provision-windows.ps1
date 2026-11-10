#Requires -Version 5.1
<#
.SYNOPSIS
  Provision a Windows server for Airlock deploys (dedicated account + sshd gate).

.DESCRIPTION
  Creates a dedicated low-privilege account (default: ag-ssh), installs the
  supplied public key, lays out the deploy directory, generates the deploy
  launcher, and pins that account to the deployer through sshd ForceCommand.

  The account is deliberately NOT added to Administrators: it can only ever
  run the deployer. Your interactive/RDP account is never touched.

  Idempotent: safe to re-run. The sshd_config is backed up, validated with
  `sshd -t`, and restored automatically if the new configuration is invalid.

.PARAMETER PublicKey
  The public key line to authorize, e.g. "ssh-ed25519 AAAA... comment".

.PARAMETER AccountName
  Deploy account name. Default: ag-ssh.

.PARAMETER DeployRoot
  Deploy root directory. Default: C:\airlock.

.PARAMETER NodePath
  Full path to node.exe. Default: resolved from PATH.

.PARAMETER SkipSshd
  Do not modify sshd_config (key + account + directories only).

.PARAMETER DryRun
  Print what would be done, change nothing.

.EXAMPLE
  .\provision-windows.ps1 -PublicKey 'ssh-ed25519 AAAA... dsh-matebook'
#>
param(
    [Parameter(Mandatory = $true)][string]$PublicKey,
    [string]$AccountName = 'ag-ssh',
    [string]$DeployRoot = 'C:\airlock',
    [string]$NodePath = '',
    [switch]$SkipSshd,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$GroupName = 'airlock-deploy'
$SshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
$Marker = "# --- airlock deploy account: $AccountName ---"

function Write-Step([string]$Message) {
    Write-Host "[provision] $Message"
}

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Must run from an elevated PowerShell (Run as Administrator).'
    }
}

function Test-AccountInAdministrators([string]$Name) {
    try {
        return [bool](Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop |
            Where-Object { $_.Name -match "\\$([regex]::Escape($Name))$" })
    } catch {
        return $false
    }
}

function New-RandomPassword {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', 'x'
}

# --- 0. preflight -----------------------------------------------------------
if (-not $DryRun) { Assert-Administrator }

$trimmed = $PublicKey.Trim()
if ($trimmed -notmatch '^ssh-(ed25519|rsa|dss)\s+[A-Za-z0-9+/=]+' -and
    $trimmed -notmatch '^ecdsa-sha2-[a-z0-9-]+\s+[A-Za-z0-9+/=]+') {
    throw "PublicKey does not look like an OpenSSH public key line."
}

if ($NodePath -eq '') {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw 'node.exe not found in PATH. Install Node.js >= 24 or pass -NodePath.'
    }
    $NodePath = $nodeCommand.Source
}
if (-not $DryRun -and -not (Test-Path $NodePath)) { throw "node.exe not found: $NodePath" }

$nodeVersion = (& $NodePath --version) 2>$null
Write-Step "node: $NodePath ($nodeVersion)"

# --- 1. account -------------------------------------------------------------
$existingUser = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
$generatedPassword = $null
if ($null -eq $existingUser) {
    $generatedPassword = New-RandomPassword
    Write-Step "creating local user $AccountName (random password, key-only access)"
    if (-not $DryRun) {
        $secure = ConvertTo-SecureString $generatedPassword -AsPlainText -Force
        New-LocalUser -Name $AccountName -Password $secure -PasswordNeverExpires -UserMayNotChangePassword `
            -Description 'Airlock deploy account (key-only, ForceCommand)' | Out-Null
        Set-LocalUser -Name $AccountName -Password $secure
    }
} else {
    Write-Step "local user $AccountName already exists, reusing it"
}

if (Test-AccountInAdministrators $AccountName) {
    Write-Step "WARNING: $AccountName is in Administrators; sshd will read the shared administrators_authorized_keys file"
    $isAdminAccount = $true
} else {
    $isAdminAccount = $false
}

# --- 2. group ---------------------------------------------------------------
$group = Get-LocalGroup -Name $GroupName -ErrorAction SilentlyContinue
if ($null -eq $group) {
    Write-Step "creating local group $GroupName"
    if (-not $DryRun) {
        New-LocalGroup -Name $GroupName -Description 'Airlock deploy accounts' | Out-Null
    }
}
if (-not $DryRun) {
    Add-LocalGroupMember -Group $GroupName -Member $AccountName -ErrorAction SilentlyContinue
}

# --- 3. directories ---------------------------------------------------------
foreach ($relative in @('', 'bin', 'config', 'apps')) {
    $target = if ($relative -eq '') { $DeployRoot } else { Join-Path $DeployRoot $relative }
    Write-Step "ensure directory $target"
    if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
}
if (-not $DryRun) {
    # Modify (not Full) for the deploy group: the account can write app files but not re-ACL the tree.
    & icacls $DeployRoot /grant "${GroupName}:(OI)(CI)M" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $DeployRoot (exit $LASTEXITCODE)" }
}

# --- 4. authorized key ------------------------------------------------------
$keyBody = ($trimmed -split '\s+')[1]
if ($isAdminAccount) {
    # Administrative accounts are matched by a Match Group block in the default
    # sshd_config, so the per-user file is ignored entirely.
    $authFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
} else {
    $authFile = Join-Path "C:\Users\$AccountName" '.ssh\authorized_keys'
}
Write-Step "authorize key in $authFile"
if (-not $DryRun) {
    $authDir = Split-Path -Parent $authFile
    New-Item -ItemType Directory -Force -Path $authDir | Out-Null
    $alreadyThere = $false
    if (Test-Path $authFile) {
        $alreadyThere = [bool](Select-String -Path $authFile -Pattern $keyBody -SimpleMatch -Quiet)
    }
    if (-not $alreadyThere) {
        Add-Content -Path $authFile -Value $trimmed -Encoding ASCII
    }
    if ($isAdminAccount) {
        & icacls $authFile /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' /Q | Out-Null
    } else {
        & icacls $authFile /inheritance:r /grant "${AccountName}:F" /grant 'Administrators:F' /grant 'SYSTEM:F' /Q | Out-Null
    }
}

# --- 5. deploy launcher -----------------------------------------------------
$launcher = Join-Path $DeployRoot 'bin\deploy.cmd'
$deployer = Join-Path $DeployRoot 'bin\airlock-deployer.mjs'
$configFile = Join-Path $DeployRoot 'config\deployer.json'
Write-Step "write launcher $launcher"
if (-not $DryRun) {
    $content = @(
        '@echo off',
        "`"$NodePath`" `"$deployer`" --config `"$configFile`""
    ) -join "`r`n"
    Set-Content -Path $launcher -Value $content -Encoding ASCII
}
if (-not (Test-Path $deployer) -and -not $DryRun) {
    Write-Step "NOTE: $deployer does not exist yet; copy the Airlock tree there before enabling sshd."
}

# --- 6. sshd gate -----------------------------------------------------------
if (-not $SkipSshd) {
    if (-not (Test-Path $SshdConfig)) { throw "sshd_config not found: $SshdConfig" }
    $backup = "$SshdConfig.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Step "backup sshd_config -> $backup"
    if (-not $DryRun) { Copy-Item -Path $SshdConfig -Destination $backup -Force }

    $block = @"
$Marker
Match User $AccountName
    ForceCommand "$launcher"
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    AllowAgentForwarding no
"@

    $original = if ($DryRun) { '' } else { Get-Content -Path $SshdConfig -Raw }
    $pattern = "(?ms)^# --- airlock deploy account: .*?^Match User $([regex]::Escape($AccountName))\r?\n(?:[ \t]+.*\r?\n)*"
    $updated = if ($original -match $pattern) {
        [regex]::Replace($original, $pattern, $block + "`r`n")
    } else {
        $original.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
    }

    if (-not $DryRun) {
        Set-Content -Path $SshdConfig -Value $updated -Encoding ASCII
        $sshdExe = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
        if (-not (Test-Path $sshdExe)) { $sshdExe = (Get-Command sshd -ErrorAction SilentlyContinue).Source }
        if (-not $sshdExe) { throw 'sshd.exe not found; restore sshd_config from backup manually.' }

        & $sshdExe -t -f $SshdConfig 2>&1 | ForEach-Object { Write-Step "sshd -t: $_" }
        if ($LASTEXITCODE -ne 0) {
            Copy-Item -Path $backup -Destination $SshdConfig -Force
            throw "sshd_config validation failed; restored $backup. Nothing was reloaded."
        }
        Write-Step 'sshd_config valid; restarting sshd (existing SSH sessions will drop)'
        Restart-Service sshd -Force
    }
}

# --- 7. summary -------------------------------------------------------------
Write-Host ''
Write-Step 'done. summary:'
Write-Host "  account         : $AccountName"
Write-Host "  group           : $GroupName"
Write-Host "  in administrators: $isAdminAccount"
Write-Host "  authorized_keys : $authFile"
Write-Host "  deploy root     : $DeployRoot"
Write-Host "  launcher        : $launcher"
if (-not $SkipSshd) { Write-Host "  sshd gate       : ForceCommand -> $launcher (PermitTTY no)" }
if ($generatedPassword) {
    Write-Host "  generated password: $generatedPassword"
    Write-Host '  (store or discard it; the account is meant to authenticate by key only)'
}
Write-Host ''
Write-Host 'Next:'
Write-Host "  1. copy the Airlock tree to $DeployRoot (bin\, src\, node_modules\, package.json)"
Write-Host "  2. write $configFile (see examples/deployer.example.json)"
Write-Host "  3. from your workstation: node bin/airlock-deploy.mjs status"
