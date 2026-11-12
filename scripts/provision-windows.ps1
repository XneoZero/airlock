#Requires -Version 5.1
<#
.SYNOPSIS
  Provision a Windows server for Airlock deploys (dedicated account + sshd gate).

.DESCRIPTION
  Creates a dedicated low-privilege account (default: ag-ssh), installs the
  supplied public key, lays out the deploy directory, generates the deploy
  launcher, and pins that account to the deployer through sshd ForceCommand.

  The account is deliberately NOT added to Administrators unless -GrantAdministrator
  is passed: bare-process hosting (schtasks /ru SYSTEM) needs it, and a non-admin
  cannot do it. Your interactive/RDP account is never touched either way.

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

.PARAMETER AppId
  App id seeded into the generated deployer.json. Default: app.

.PARAMETER AppRoot
  Deploy root for that app. Default: <administrator desktop>\<AppId>,
  i.e. C:\Users\Administrator\Desktop\<app> — the place an operator sees first.

.PARAMETER Layout
  How the app root is laid out: nested | flat | mirror. Default: mirror.
  mirror means the root is a plain copy of the published source (no releases/,
  no current link); version history and rollback live in git.

.PARAMETER HealthPort
  Loopback port for the generated health check. Default: 18080.

.PARAMETER EntryFile
  App entry file inside a release (relative to the version dir). Default: server.mjs.

.PARAMETER GrantAdministrator
  Also add the deploy account to Administrators. Needed for bare-process hosting
  on Windows (schtasks /ru SYSTEM, CIM): a non-admin cannot start or trigger jobs
  owned by SYSTEM. This trades account-level isolation for the ability to run the
  app at all — see docs/DEPLOY.md "受限账号的权限现实".

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
    [string]$AppId = 'app',
    [string]$AppRoot = '',
    [ValidateSet('nested','flat','mirror')][string]$Layout = 'mirror',
    [int]$HealthPort = 18080,
    [string]$EntryFile = 'server.mjs',
    [switch]$SkipSshd,
    [switch]$GrantAdministrator,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$GroupName = 'airlock-deploy'
$SshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
$Marker = "# --- airlock deploy account: $AccountName ---"

function Write-Step([string]$Message) {
    Write-Host "[provision] $Message"
}

function Ensure-AllowGroup([string]$Name) {
    # sshd 的 AllowGroups 是白名单：账号不在其中任何一个组里时，认证阶段就拒掉，
    # 日志写 "none of user's groups are listed in AllowGroups"，看着像密钥问题。
    # 中文 Windows 更绕：本地组叫「OpenSSH 用户」，配置里写的是英文 "openssh users"，
    # 按名字永远匹配不上 —— 所以把自建的英文组补进白名单才是通用解。
    $lines = @(Get-Content -Path $SshdConfig)
    $index = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*AllowGroups\s+(.+)$') { $index = $i; break }
    }
    if ($index -lt 0) { return }
    $value = $Matches[1]
    if ($value -match "(^|\s)`"?$([regex]::Escape($Name))`"?(\s|$)") { return }
    $lines[$index] = "AllowGroups $value $Name"
    Set-Content -Path $SshdConfig -Value $lines -Encoding ASCII
    Write-Step "AllowGroups += $Name"
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

if ($GrantAdministrator -and -not $DryRun) {
    # Bare-process hosting: schtasks /ru SYSTEM、CIM 创建进程都需要管理员权限。
    Add-LocalGroupMember -Group 'Administrators' -Member $AccountName -ErrorAction SilentlyContinue
    Write-Step "added $AccountName to Administrators (-GrantAdministrator)"
} elseif ($GrantAdministrator) {
    Write-Step "would add $AccountName to Administrators (-GrantAdministrator)"
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

# --- 3b. default app config: deploy root lives on the administrator desktop ---
# 「默认发布在桌面」是刻意的：运维登录上去一眼就能看到产物。但部署账号读不到别人的
# profile 目录，所以要把 ACL 授给部署组，否则第一次 release 建 releases/ 就会失败。
# 启停脚本放在 DeployRoot\bin，与落点解耦：以后改 root 不用重写它们。
$DesktopRoot = 'C:\Users\Administrator\Desktop'
$AppRoot = if ($AppRoot -ne '') { $AppRoot } else { Join-Path $DesktopRoot $AppId }
$appConfigPath = Join-Path $DeployRoot 'config\deployer.json'
$appStartCmd = Join-Path $DeployRoot "bin\start-$AppId.cmd"
$appStopPs1 = Join-Path $DeployRoot "bin\stop-$AppId.ps1"

if ($DryRun) {
    Write-Step "would set app root to $AppRoot"
    Write-Step "would seed $appConfigPath (only when missing)"
} elseif (Test-Path $appConfigPath) {
    Write-Step "keep existing $appConfigPath (已有配置不覆盖，落点见文件)"
} else {
    Write-Step "app root -> $AppRoot"
    New-Item -ItemType Directory -Force -Path $AppRoot | Out-Null
    & icacls $AppRoot /grant "${GroupName}:(OI)(CI)M" /T /Q | Out-Null

    $config = [ordered]@{
        serverId = ('srv-' + $env:COMPUTERNAME).ToLower()
        kind = 'windows'
        apps = [ordered]@{
            $AppId = [ordered]@{
                root = $AppRoot
                # mirror（默认）：落点就是发布源的副本，不带 releases/、current、state.json；
                # 版本与状态在 <root 父目录>\.airlock\<app> 下，回退靠 git checkout 再发一版。
                layout = $Layout
                runtime = [ordered]@{
                    start = [ordered]@{
                        command = (Join-Path $env:SystemRoot 'System32\cmd.exe')
                        args = @('/c', $appStartCmd)
                        cwd = 'current'
                        timeoutMs = 30000
                    }
                    stop = [ordered]@{
                        command = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
                        args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $appStopPs1)
                        cwd = 'root'
                        timeoutMs = 15000
                    }
                }
                health = [ordered]@{
                    url = "http://127.0.0.1:$HealthPort/health"
                    expectStatus = 200
                    timeoutMs = 30000
                    intervalMs = 500
                }
            }
        }
    }
    # mirror 不在服务器保留历史版本，keepReleases 对它没有意义，不写进配置。
    if ($Layout -ne 'mirror') { $config.apps[$AppId].keepReleases = 5 }

    [System.IO.File]::WriteAllText($appConfigPath, ($config | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

    $startBody = @"
@echo off
rem Generated by scripts/provision-windows.ps1.
rem %CD% is the version dir (deployer.json sets cwd=current), so changing the app
rem root never needs an edit here. Replace server.mjs with your own entry point.
set APP=$AppId
schtasks /create /tn airlock-%APP%-start /tr "$NodePath %CD%\$EntryFile" /sc once /st 00:00 /ru SYSTEM /f >nul 2>&1
if errorlevel 1 exit /b 2
schtasks /run /tn airlock-%APP%-start >nul 2>&1
if errorlevel 1 exit /b 3
exit /b 0
"@
    $startBody = ($startBody -replace "`r`n", "`n") -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($appStartCmd, $startBody, (New-Object System.Text.ASCIIEncoding))

    $stopBody = @'
# Generated by scripts/provision-windows.ps1: reads app.pid from the app root
# (deployer.json sets cwd=root). Same convention as examples/windows/stop-app.ps1.
$pidFile = 'app.pid'
if (-not (Test-Path $pidFile)) { exit 0 }
$raw = (Get-Content $pidFile -Raw).Trim()
$target = 0
if (-not [int]::TryParse($raw, [ref]$target) -or $target -le 0) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}
if (Get-Process -Id $target -ErrorAction SilentlyContinue) {
    Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
'@
    $stopBody = $stopBody + "`nschtasks /end /tn airlock-$AppId-start 2>`$null | Out-Null`n"
    [System.IO.File]::WriteAllText($appStopPs1, $stopBody, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "seeded $appConfigPath for app '$AppId' (health url 记得改成你应用的端口)"
}

# --- 4. authorized key ------------------------------------------------------
# Windows local accounts live in C:\Users\<name>.<machine>, NOT C:\Users\<name>.
# sshd resolves AuthorizedKeysFile against the real profile directory, so writing
# to the "obvious" path silently does nothing. Always look the profile up first.
function Get-ProfileDirectory([string]$Name) {
    $pattern = '\\' + [regex]::Escape($Name) + '(\.[^.\\]+)?$'
    $entry = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.ProfileImagePath -match $pattern } |
        Select-Object -First 1
    if ($null -eq $entry) { return $null }
    return $entry.ProfileImagePath
}

$keyBody = ($trimmed -split '\s+')[1]
$profileDir = if ($DryRun) { "C:\Users\$AccountName.<machine>" } else { Get-ProfileDirectory $AccountName }
if ($null -eq $profileDir -and -not $DryRun -and $null -ne $generatedPassword) {
    # 刚建的账号还没有 profile 目录。它不会有任何交互式登录，所以得替它触发一次：
    # 用一个该账号身份的进程（CreateProcessWithLogonW）让 Windows 把 profile 建出来。
    # 不建的话，sshd 解析 %h% 会失败，密钥就算写对了也只会得到 publickey denied。
    Write-Step "no profile for $AccountName yet; creating one with the generated password"
    try {
        $cred = New-Object System.Management.Automation.PSCredential(
            $AccountName, (ConvertTo-SecureString $generatedPassword -AsPlainText -Force))
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
            -ArgumentList '/c', 'exit' -Credential $cred -Wait -ErrorAction Stop
        Start-Sleep -Seconds 2
        $profileDir = Get-ProfileDirectory $AccountName
    } catch {
        Write-Step "WARNING: could not create the profile automatically: $($_.Exception.Message)"
    }
}
if ($null -eq $profileDir) {
    $hint = if ($generatedPassword) { " Password: $generatedPassword" } else { '' }
    throw "No profile directory for $AccountName yet. Log in as that account once (console/RDP), then re-run.$hint"
}
$authFile = Join-Path $profileDir '.ssh\authorized_keys'
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
    # Per-user file: owner must be the account itself, and keep it readable by
    # SYSTEM (sshd) and Administrators. Do NOT strip inheritance wholesale here;
    # a failed /grant would leave sshd unable to read the file.
    try {
        $acl = Get-Acl -Path $authFile
        $acl.SetOwner([System.Security.Principal.NTAccount]"$env:COMPUTERNAME\$AccountName")
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            "$env:COMPUTERNAME\$AccountName", 'FullControl', 'Allow')
        $acl.SetAccessRule($rule)
        Set-Acl -Path $authFile -AclObject $acl
    } catch {
        Write-Step "WARNING: could not set owner/ACL on $authFile : $($_.Exception.Message)"
    }
    Write-Step "authorized_keys owner: $((Get-Acl $authFile).Owner)"
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

    if (-not $DryRun) { Ensure-AllowGroup $GroupName }

    # Pin this account to its own authorized_keys explicitly. The global
    # AuthorizedKeysFile is often pointed at the shared administrators file on
    # Windows servers, which silently ignores per-user keys.
    $keyPathForSshd = ($authFile -replace '\\', '/')
    $block = @"
$Marker
Match User $AccountName
    AuthorizedKeysFile "$keyPathForSshd"
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
        # Arm a 10-minute rollback before touching the live service: if the new
        # config locks everyone out, this puts the previous file back by itself.
        $rollbackCmd = "Copy-Item '$backup' '$SshdConfig' -Force; Restart-Service sshd -Force"
        try {
            $action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
                -Argument "-NoProfile -Command `"$rollbackCmd`""
            $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
            Register-ScheduledTask -TaskName 'airlock-sshd-rollback' -Action $action -Trigger $trigger `
                -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
            Write-Step 'rollback guard armed for 10 minutes (airlock-sshd-rollback)'
        } catch {
            Write-Step "WARNING: could not arm rollback guard: $($_.Exception.Message)"
        }
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
Write-Host "  app             : $AppId -> $AppRoot"
Write-Host "  launcher        : $launcher"
if (-not $SkipSshd) {
    Write-Host "  sshd gate       : ForceCommand -> $launcher (PermitTTY no)"
    Write-Host "  AllowGroups     : $GroupName 已并入白名单（没有这一条会是 publickey denied）"
}
if ($generatedPassword) {
    Write-Host "  generated password: $generatedPassword"
    Write-Host '  (store or discard it; the account is meant to authenticate by key only)'
}
Write-Host ''
Write-Host 'Next:'
if (Test-Path $deployer) {
    Write-Host "  1. Airlock 树已就位：$DeployRoot"
} else {
    Write-Host "  1. copy the Airlock tree to $DeployRoot (bin\, src\, node_modules\, package.json)"
}
Write-Host "  2. deployer.json: 缺省时已按桌面落点生成（$appConfigPath），health 端口=$HealthPort"
Write-Host "  3. from your workstation: node bin/airlock-deploy.mjs status"
