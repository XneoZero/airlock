#Requires -Version 5.1
<#
.SYNOPSIS
  一条命令把一台 Windows 机器准备成 Airlock 的部署目标。

.DESCRIPTION
  本来要手工做五六步（下载源码、装 Node、传文件、建账号、配 sshd、写落点），
  在中文 Windows + 国内网络下每步都能卡住人。这个脚本把它们串起来：

    1. 下载 Airlock 源码（GitHub 直连失败会依次换国内镜像重试）
    2. 装 Node 24 到 C:\nodejs（npmmirror，不污染 PATH）
    3. 解到 C:\airlock 并 npm ci --omit=dev
    4. 建部署账号 + 密钥 + sshd 门禁（调用 scripts\provision-windows.ps1）
    5. 在管理员桌面生成默认落点配置与启停脚本，并授权给部署组

  跑完就能在本机 `node bin/airlock-deploy.mjs status` 看到这台机器。

.PARAMETER PublicKey
  agent 本机的公钥整行，例如 ssh-ed25519 AAAA... ag-ssh-deploy。

.PARAMETER AppId
  生成 deployer.json 时用的应用 id。默认 app。

.PARAMETER HealthPort
  健康检查端口，写进生成的 deployer.json。默认 18080。

.PARAMETER EntryFile
  应用入口文件名（相对版本目录）。默认 server.mjs。

.PARAMETER SourceZipUrl
  直接指定源码 zip 地址（内网镜像/离线包），跳过内置的镜像列表。

.EXAMPLE
  .\bootstrap-windows.ps1 -PublicKey 'ssh-ed25519 AAAA... ag-ssh-deploy' -AppId demo
#>
param(
    [Parameter(Mandatory = $true)][string]$PublicKey,
    [string]$AccountName = 'ag-ssh',
    [string]$AppId = 'app',
    [string]$DeployRoot = 'C:\airlock',
    [string]$NodeRoot = 'C:\nodejs',
    [int]$HealthPort = 18080,
    [string]$EntryFile = 'server.mjs',
    [string]$SourceZipUrl = '',
    [switch]$SkipSshd,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Temp = 'C:\Windows\Temp\airlock-bootstrap'

function Write-Step([string]$Message) { Write-Host "[bootstrap] $Message" }

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Must run from an elevated PowerShell (Run as Administrator).'
    }
}

if (-not $DryRun) { Assert-Administrator }
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $Temp | Out-Null }

# --- 1. 源码：GitHub 直连在国内云主机上经常被 reset，按镜像顺序试 ----------
$candidates = if ($SourceZipUrl -ne '') {
    @($SourceZipUrl)
} else {
    @(
        'https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main',
        'https://ghproxy.net/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main',
        'https://gh-proxy.com/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main',
        'https://ghfast.top/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main'
    )
}

$zip = Join-Path $Temp 'airlock.zip'
$got = $false
foreach ($url in $candidates) {
    Write-Step "download source: $url"
    if ($DryRun) { $got = $true; break }
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    & curl.exe -fsS -L --max-time 180 -o $zip $url 2>$null
    if ((Test-Path $zip) -and (Get-Item $zip).Length -gt 50000) { $got = $true; break }
    Write-Step '  failed, trying next mirror'
}
if (-not $got) { throw "源码下载失败。用 -SourceZipUrl 指定一个能访问的镜像地址再试。" }

$extract = Join-Path $Temp 'extract'
if (-not $DryRun) {
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
    $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $DeployRoot | Out-Null
    Copy-Item (Join-Path $inner.FullName '*') $DeployRoot -Recurse -Force
    Write-Step "source -> $DeployRoot"
}

# --- 2. Node 24（zip 免安装，不写 PATH）-----------------------------------
$nodeExe = Join-Path $NodeRoot 'node.exe'
if (-not $DryRun -and -not (Test-Path $nodeExe)) {
    Write-Step 'install Node 24'
    $index = Join-Path $Temp 'node-index.json'
    & curl.exe -fsS -L --max-time 120 -o $index 'https://npmmirror.com/mirrors/node/index.json'
    $version = ((Get-Content $index -Raw | ConvertFrom-Json) | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1).version
    Write-Step "  version $version"
    $nodeZip = Join-Path $Temp 'node.zip'
    & curl.exe -fsS -L --max-time 900 -o $nodeZip "https://npmmirror.com/mirrors/node/$version/node-$version-win-x64.zip"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $nodeExtract = Join-Path $Temp 'node'
    Remove-Item $nodeExtract -Recurse -Force -ErrorAction SilentlyContinue
    [System.IO.Compression.ZipFile]::ExtractToDirectory($nodeZip, $nodeExtract)
    $dir = Get-ChildItem $nodeExtract -Directory | Select-Object -First 1
    if (Test-Path $NodeRoot) { Remove-Item $NodeRoot -Recurse -Force }
    Move-Item $dir.FullName $NodeRoot -Force
} elseif ($DryRun) {
    Write-Step "would install node to $NodeRoot if missing"
} else {
    Write-Step "node already present: $nodeExe"
}
if (-not $DryRun) { Write-Step "node: $(& $nodeExe --version)" }

# --- 3. 依赖（生产依赖即可，测试与 tsc 是开发期的事）-----------------------
if (-not $DryRun) {
    Write-Step 'npm ci --omit=dev'
    Push-Location $DeployRoot
    try {
        & (Join-Path $NodeRoot 'npm.cmd') ci --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE). 检查 $DeployRoot\package-lock.json 是否存在。" }
    } finally {
        Pop-Location
    }
}

# --- 4/5. 账号、门禁、桌面落点：交给 provision 脚本 -------------------------
$provision = if ($DryRun) {
    # DryRun 不去下载源码，用当前这份脚本旁边的 provision 演练流程
    Join-Path $PSScriptRoot 'provision-windows.ps1'
} else {
    Join-Path $DeployRoot 'scripts\provision-windows.ps1'
}
if (-not $DryRun -and -not (Test-Path $provision)) { throw "找不到 $provision，源码可能没解开。" }

Write-Step 'provision account + sshd gate + desktop app root'
$provisionArgs = @{
    PublicKey      = $PublicKey
    AccountName    = $AccountName
    DeployRoot     = $DeployRoot
    AppId          = $AppId
    HealthPort     = $HealthPort
    EntryFile      = $EntryFile
    GrantAdministrator = $true
}
if (-not $DryRun) { $provisionArgs.NodePath = $nodeExe }
if ($SkipSshd) { $provisionArgs.SkipSshd = $true }
if ($DryRun) { $provisionArgs.DryRun = $true }

Set-ExecutionPolicy -Scope Process Bypass -Force
& $provision @provisionArgs

Write-Host ''
Write-Step 'done. 从你的工作站验证：'
Write-Host "  node bin/airlock-deploy.mjs status --app $AppId --profiles <你的档案>"
Write-Host "  落点：C:\Users\Administrator\Desktop\$AppId"
Write-Host "  健康检查端口：$HealthPort（生成的 deployer.json 里，端口不对要改）"
