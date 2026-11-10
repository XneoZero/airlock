# 新服务器接入 checklist

复制这份清单，从上往下做，**每步都有「验证」——不通过就别往下走**。

本文基于 2026-11-10 一次真实的从零接入（Windows Server 2025 / Node 24.22 / OpenSSH），
所有坑都是当场踩出来的，不是推测。

---

## 0. 开工前

| 需要 | 说明 |
|---|---|
| 服务器管理员访问 | RDP 或云控制台。**必须**，因为 SSH 还没配好，改错也只能靠它救 |
| 服务器公网 IP | 后面配 profile 和白名单要用 |
| 本机一把专用私钥 | `ssh-keygen -t ed25519 -f ~/.ssh/ag_deploy_ed25519 -N "" -C ag-deploy` |
| Node ≥ 24 | 服务器上装，见第 2 步 |

**先想清楚**：部署账号要不要管理员权限？Windows 上托管裸进程必须要（[原因](DEPLOY.md)）。
如果不想给，先决定走服务方案（winsw/nssm），否则做到第 4 步会卡住。

---

## 1. 体检（管理员 PowerShell）

```powershell
(Get-CimInstance Win32_OperatingSystem).Caption
[Environment]::OSVersion.VersionString
Get-PSDrive C | ForEach-Object { "C: free={0:N1}GB" -f ($_.Free/1GB) }
Get-Service sshd | Select-Object Status, StartType
(Get-Command node -ErrorAction SilentlyContinue).Source
Test-Path C:\airlock
```

**验证**：磁盘 ≥ 10 GB 空闲；`sshd` 存在且 Running（OpenSSH Server 功能已装）。

没装 OpenSSH Server：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
```

---

## 2. 装 Node ≥ 24（zip 免安装，不污染系统）

```powershell
$tmp = 'C:\Windows\Temp\node-setup'; New-Item -ItemType Directory -Force $tmp | Out-Null
curl.exe -fsS -L --max-time 90 -o "$tmp\index.json" https://npmmirror.com/mirrors/node/index.json
$v = ((Get-Content "$tmp\index.json" -Raw | ConvertFrom-Json) | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1).version
curl.exe -fsS -L --max-time 900 -o "$tmp\node.zip" "https://npmmirror.com/mirrors/node/$v/node-$v-win-x64.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("$tmp\node.zip", "$tmp\extract")
$dir = Get-ChildItem "$tmp\extract" -Directory | Select-Object -First 1
Move-Item $dir.FullName 'C:\nodejs' -Force
```

**验证**：

```powershell
C:\nodejs\node.exe --version    # 应该 >= v24
C:\nodejs\npm.cmd --version
```

> **坑**：Node 装在 `C:\nodejs` 时**不在 PATH 里**。后面所有配置里的命令一律写绝对路径
> `C:\nodejs\node.exe`，别指望 `node` 能解析。下载 URL 里的文件名是大坑：是
> `node-v24.x.x-win-x64.zip`，**带 `node-` 前缀**，少写会下载到 0 字节。

---

## 3. 传 Airlock

本机打包（排除依赖和测试）：

```powershell
tar -czf "$env:TEMP\airlock-src.tar.gz" -C C:\path\to\Airlock `
    --exclude=node_modules --exclude=.git --exclude=config --exclude=test .
scp "$env:TEMP\airlock-src.tar.gz" user@host:"C:/Windows/Temp/airlock-src.tar.gz"
```

服务器解压 + 装依赖：

```powershell
New-Item -ItemType Directory -Force C:\airlock | Out-Null
tar -xzf C:\Windows\Temp\airlock-src.tar.gz -C C:\airlock
Set-Location C:\airlock
& C:\nodejs\npm.cmd ci --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
```

**验证**：

```powershell
C:\nodejs\node.exe C:\airlock\bin\airlock-deployer.mjs --help
Get-ChildItem C:\airlock\node_modules | Select-Object -ExpandProperty Name
```

> **坑**：`npm ci` 后面接管道时 `$LASTEXITCODE` 会变成 -1，看着像失败其实成功了。
> 以 `node_modules` 里有没有 `tar`、`zod` 为准。

---

## 4. 建部署账号 + sshd 门禁

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
& C:\airlock\scripts\provision-windows.ps1 `
    -PublicKey 'ssh-ed25519 AAAA... your-key' `
    -AccountName ag-ssh `
    -NodePath C:\nodejs\node.exe
```

**验证 1**：账号建出来了

```powershell
Get-LocalUser ag-ssh | Select-Object Name, Enabled
Get-LocalGroupMember -Group airlock-deploy
```

**验证 2**：门禁生效（从本机）

```powershell
# 用正确的 key 连，发一行协议，应该返回 JSON
'{"v":1,"id":1,"op":"status"}' | ssh -i ~/.ssh/ag_deploy_ed25519 ag-ssh@<IP> "ignored"

# 用别人的 key 连，应该 Permission denied
ssh -i ~/.ssh/other_key ag-ssh@<IP> "echo leak"
```

> **坑 1（最常见）**：Windows 本地用户的 profile 目录是 `C:\Users\<用户名>.<机器名>`，
> **不是** `C:\Users\<用户名>`。key 写错位置的表现是「明明加了还是 Permission denied」。
> 脚本会用 `ProfileList` 查真实路径，但账号**从没登录过**时注册表里没项，脚本会报错
> 让你先登录一次。
>
> **坑 2**：如果 `sshd_config` 顶层 `AuthorizedKeysFile` 指着共享的
> `__PROGRAMDATA__/ssh/administrators_authorized_keys`，所有账号都读同一个文件。
> 脚本用 `Match User` 显式声明路径绕开它。
>
> **坑 3**：`AllowUsers` 白名单里没这个账号时，sshd 直接报 `Invalid user`——不是 key 的问题。
>
> **坑 4**：不要把账号加进 Administrators 之前先测——管理员组账号在部分配置下会读共享
> 密钥文件，行为和非管理员账号不同。

---

## 5. 配应用

写 `C:\airlock\config\deployer.json`（参考 `examples/deployer.example.json`），关键三条：

1. **`runtime.start` 必须启动后就返回**——deployer 是短命进程，HTTP 服务不退出会把 start 卡到超时
2. **命令路径用反斜杠**——`C:/Windows/System32/cmd.exe` 会让 cmd 报「命令语法不正确」
3. **`health` 一定要配**——没有它，起不来的版本也会被当成发布成功

Windows 裸进程的 start 脚本（`C:\airlock\bin\start-app.cmd`，**必须 CRLF + ASCII**）：

```cmd
@echo off
schtasks /create /tn myapp-start /tr "C:\nodejs\node.exe C:\airlock\apps\myapp\current\server.mjs" /sc once /st 00:00 /ru SYSTEM /f >nul 2>&1
if errorlevel 1 exit /b 2
schtasks /run /tn myapp-start >nul 2>&1
if errorlevel 1 exit /b 3
exit /b 0
```

应用自己写 pid 到应用根（注意 `current` 是 junction，要先 `realpathSync`）：

```js
const here = realpathSync(fileURLToPath(import.meta.url));
const appRoot = join(dirname(here), '..', '..');   // releases/<ver> -> 应用根
writeFileSync(join(appRoot, 'app.pid'), String(process.pid));
```

**验证**：手动跑一次启停

```powershell
Set-Location C:\airlock\apps\myapp
& C:\Windows\System32\cmd.exe /c C:\airlock\bin\start-app.cmd
Start-Sleep 3
curl.exe -s http://127.0.0.1:18080/health     # 应该 200
Get-Content .\app.pid
& powershell -ExecutionPolicy Bypass -File C:\airlock\bin\stop-app.ps1
```

> **坑**：`Start-Process` 起的服务会被 SSH 会话带走（sshd 用 job object 清理进程树）。
> 表现是「发布时健康检查过了，发布结束几秒端口就没了」。必须用 `schtasks`/服务/CIM。
> 非管理员账号用 CIM 会被「拒绝访问」。

---

## 6. 首次发布

本机 `config/deploy-profiles.json`：

```json
{
  "default": "test",
  "profiles": {
    "test": {
      "host": "<IP>",
      "user": "ag-ssh",
      "identityFile": "C:/Users/you/.ssh/ag_deploy_ed25519",
      "hostKeyChecking": "accept-new",
      "serverId": "srv-test01",
      "deployerCommand": "C:/airlock/bin/deploy.cmd",
      "workspace": "C:/work/your-app"
    }
  }
}
```

发布：

```powershell
node bin/airlock-deploy.mjs status --app myapp
node bin/airlock-deploy.mjs release --app myapp --source C:\work\your-app\dist
```

**验证**（三条都要看）：

```powershell
# 1. 发布返回里 health.ok === true
# 2. 断开后服务还在
curl http://<IP>:18080/health        # 需要端口允许外部访问；或本地 curl 后看
# 3. 目录正确
Get-Item C:\airlock\apps\myapp\current
```

---

## 7. 回滚演练（别跳过）

1. **发一个故意起不来的版本**，确认自动回退：

   ```powershell
   # 改一行代码让它启动即退出，然后发布
   node bin/airlock-deploy.mjs release --app myapp --source <坏版本目录> --version v-bad
   # 预期：HEALTH_FAILED，自动切回上一版
   ```

2. **手动回滚**：

   ```powershell
   node bin/airlock-deploy.mjs rollback --app myapp
   node bin/airlock-deploy.mjs status --app myapp
   ```

**验证**：`current` 指回旧版本、服务重新起来、`state.json` 里坏版本是 `failed`。

---

## 8. 加固

### 8.1 一人一钥

每个账号一把独立 key，写进各自的 profile 目录（`C:\Users\<用户>.<机器名>\.ssh\authorized_keys`），
owner 设为账号本人。**逐账号验证**：拿 A 的 key 连 B 必须失败。

### 8.2 来源 IP 白名单

```powershell
$allowed = '<你的公网IP>'
New-NetFirewallRule -DisplayName 'Airlock SSH allowlist' -Direction Inbound -Protocol TCP `
    -LocalPort 22 -RemoteAddress $allowed -Action Allow -Profile Any
Get-NetFirewallRule -DisplayName '*SSH*' | Disable-NetFirewallRule
```

**顺序**：先建限制规则、确认生效，**再**禁用宽松规则。反过来中间有个「谁都进不来」的窗口。

**验证**：新开一个 SSH 连接能进；别急着关掉 RDP。

> **记住**：IP 会变。换网络进不去时，从 RDP 执行
> `Set-NetFirewallRule -DisplayName 'Airlock SSH allowlist' -RemoteAddress '<新IP>'`。

### 8.3 改 sshd 前挂回滚

任何改 `sshd_config` 的操作，**先** 注册一个 10 分钟后自动还原的计划任务，改完验证通过再删。
细节见 [DEPLOY.md](DEPLOY.md) 的「SSH 加固」。

---

## 9. 故障对照表

| 现象 | 最可能原因 | 处理 |
|---|---|---|
| `Permission denied (publickey)`，日志 `Invalid user` | 账号不存在 / 不在 `AllowUsers` | 建账号或加白名单 |
| `Permission denied`，日志正常 | key 写错目录（profile 带 `.机器名`） | 查 `ProfileList` 真实路径 |
| 所有账号同时进不去 | `AuthorizedKeysFile` 或 ACL 改坏 | 恢复 `sshd_config.bak-*` |
| ssh 能连，`deployer` 报 `is not recognized` | Node 不在 PATH | profile 里写 `C:\nodejs\node.exe` |
| `START_FAILED: 命令语法不正确` | 命令路径用了正斜杠，或 `.cmd` 是 LF | 路径改反斜杠；`.cmd` 存 CRLF |
| 健康检查过，几秒后服务没了 | `Start-Process` 被 SSH 会话回收 | 改 `schtasks` 或服务 |
| `拒绝访问` (CIM) | 账号不是管理员 | 提权或改预注册任务 |
| 发布成功但端口不通 | `health` 没配 | 配上 URL/命令探针 |
| `app.pid` 找不到 | junction 路径导致 `../` 少一层 | `realpathSync` + `dirname` 后退两级 |
| `VERSION_EXISTS` | 同版本号重发 | 换版本号，或先删 `releases/<ver>` |
| 换网络后 SSH 连不上 | IP 白名单 | RDP 里加新 IP |

---

## 10. 收尾检查

- [ ] `node bin/airlock-deploy.mjs status` 能返回服务器状态
- [ ] `release` 能发一个新版本，健康检查通过
- [ ] 发坏版本能自动回退，`current` 回到上一版
- [ ] `rollback` 能手动切回
- [ ] 每个账号用各自的 key，交叉验证失败
- [ ] IP 白名单生效，RDP 仍可用
- [ ] `sshd_config.bak-*` 备份留着，知道怎么恢复
- [ ] 服务器上 `state.json` 与 `current` 一致（`status` 里 `consistent: true`）
