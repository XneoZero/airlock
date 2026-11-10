# 发布通道（deploy）

把本地构建好的目录推上服务器，服务起不来就自动切回上一版。这是 Airlock 的第二个通道，
和「改服务器上的文件」（`remote-dev`）是两件事：

| | remote-dev | deploy |
|---|---|---|
| 方向 | 本机 → 服务器上的工作区文件 | 本机构建产物 → 服务器版本目录 |
| 典型用途 | 排查、小改、看日志 | 发版、回滚 |
| 服务器侧 | `airlock-broker.mjs` | `airlock-deployer.mjs` |
| 能力 | 读/写/跑检查 | 装版本/切版本/重启/回滚 |

两者共用同一种传输形态（SSH + 一行 JSON），但协议、配置、权限完全分开。想只给发布权限、
不给改文件权限，就只部署 deployer。

## 准备服务器（一次性，需要管理员）

部署账号和你的运维/RDP 账号必须是两个身份，否则「SSH 一连上来就把 3389 图形会话挤掉」这类问题
永远存在（Windows 的 `fSingleSessionPerUser=1`）。默认建一个 `ag-ssh`，名字可改：

```powershell
# 在服务器上，管理员 PowerShell
.\scripts\provision-windows.ps1 -PublicKey 'ssh-ed25519 AAAA... your-key' -AccountName ag-ssh
```

脚本做五件事，重复跑不会重复建：

1. 建本地用户（随机密码、永不过期、只能 key 登录），**不加进 Administrators**
2. 建本地组 `airlock-deploy`，把账号加进去
3. 建 `C:\airlock\{bin,config,apps}`，给这个组「修改」权限（不是完全控制，避免自己改 ACL）
4. 把公钥写进**真实 profile 目录**下的 `.ssh/authorized_keys`（见下方两条坑）
5. 往 `sshd_config` 追加 `Match User <账号>`：`AuthorizedKeysFile` 显式指向该文件 +
   `ForceCommand C:\airlock\bin\deploy.cmd`，禁用 PTY/转发；**先备份、用 `sshd -t` 校验、
   失败自动还原**，并在重启前挂一个 10 分钟自动回滚任务

> **坑一：Windows 本地用户的 profile 目录是 `C:\Users\<用户名>.<机器名>`，不是 `C:\Users\<用户名>`。**
> 把 key 写到后者，sshd 永远找不到，表现就是「明明加了 key 还是 Permission denied」。
> 脚本用 `ProfileList` 注册表项查真实路径；账号从没登录过、注册表里没有项时会明确报错，
> 让你先登录一次再跑。

> **坑二：`sshd_config` 顶层的 `AuthorizedKeysFile` 如果被改成了共享的
> `__PROGRAMDATA__/ssh/administrators_authorized_keys`，所有账号都读同一个文件，
> 各自的 `.ssh/authorized_keys` 被完全忽略。** 脚本用 `Match User` 里显式声明
> `AuthorizedKeysFile` 绕开全局设置，不依赖它的值。

`deploy.cmd` 是个两行包装：调用 `node C:\airlock\bin\airlock-deployer.mjs --config C:\airlock\config\deployer.json`。
Windows 的 `ForceCommand` 会交给 `cmd.exe` 解析，路径里有空格（`C:\Program Files\nodejs`）时
直接写容易翻车，包一层 `.cmd` 最稳。

> 本机侧要改的只有一处：`config/deploy-profiles.json` 里的 `user` 字段。账号叫什么、几台服务器
> 各用什么账号，全在档案里配，代码里没有硬编码。

Linux 上这一步等价于在 `~/.ssh/authorized_keys` 那行前面加前缀，不需要改 sshd_config：

```
restrict,command="/usr/bin/node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json" ssh-ed25519 AAAA...
```

## SSH 加固（生产必做）

三个动作，按顺序做。**每一步都可能把自己锁在门外，所以先确认有 RDP/控制台兜底。**

### 1. 一人一钥

共用 `administrators_authorized_keys` 的问题：一把 key 丢了，所有账号一起沦陷，而且无法单独撤销。

```powershell
# 每个账号一把独立 key，写进各自的 profile 目录
foreach ($u in 'dev-ssh','deploy-ssh') {
    $profile = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*' |
        Where-Object { $_.ProfileImagePath -match "\\$u(\.[^.\\]+)?$" }).ProfileImagePath
    $dir = Join-Path $profile '.ssh'
    New-Item -ItemType Directory -Force $dir | Out-Null
    # ... 写入对应公钥 ...
    $acl = Get-Acl (Join-Path $dir 'authorized_keys')
    $acl.SetOwner([System.Security.Principal.NTAccount]"$env:COMPUTERNAME\$u")
    Set-Acl (Join-Path $dir 'authorized_keys') $acl
}
```

`sshd_config` 顶层改成 per-user：

```
AuthorizedKeysFile .ssh/authorized_keys
```

然后验证**每个账号各用各的 key**——不仅验证「能连」，还要验证「拿 A 的 key 连 B 应该失败」。

### 2. 来源 IP 白名单

Windows 上建议用防火墙而不是 `AllowUsers user@ip`，因为改错了还能从 RDP 救：

```powershell
$allowed = '203.0.113.10'
New-NetFirewallRule -DisplayName 'Airlock SSH allowlist' -Direction Inbound -Protocol TCP `
    -LocalPort 22 -RemoteAddress $allowed -Action Allow -Profile Any
Get-NetFirewallRule -DisplayName '*SSH*' | Disable-NetFirewallRule   # 关掉旧的 Any 规则
```

**顺序很重要**：先建限制规则，确认生效，再禁用宽松规则。反过来的话中间有个「谁都进不来」的窗口。

IP 会变（家宽、手机热点）。换网络前进不去时，从 RDP 执行：

```powershell
Set-NetFirewallRule -DisplayName 'Airlock SSH allowlist' -RemoteAddress '203.0.113.10','198.51.100.7'
```

### 3. 改 sshd 前先挂回滚

```powershell
$cfg = 'C:\ProgramData\ssh\sshd_config'
$bak = "$cfg.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $cfg $bak -Force
# ... 改配置、sshd -t ...
$rollback = "Copy-Item '$bak' '$cfg' -Force; Restart-Service sshd -Force"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -Command `"$rollback`""
Register-ScheduledTask -TaskName 'airlock-sshd-rollback' `
    -Action $action -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)) `
    -User 'SYSTEM' -RunLevel Highest -Force
Restart-Service sshd
```

验证通过后 **一定记得删掉** `airlock-sshd-rollback`，否则 10 分钟后它会把你刚改好的配置还原回去。

## 服务器目录布局

每个应用一个根目录，工具只动它下面的这些位置：

```
/srv/apps/web/
├── releases/                 每个版本一个目录，解压后原样保存
│   ├── 20261110-182233-a1b2c3d/
│   └── 20261108-090000-9f8e7d6/
├── current -> releases/...   正在运行的版本（Linux 符号链接 / Windows junction）
├── backups/                  发布前数据快照（配置了 backupPaths 才有）
│   └── 20261110-182233-a1b2c3d.tar.gz
├── incoming/                 上传中的临时包，装完即删
├── state.json                当前版本 + 版本历史
└── deploy.log                发布日志（每次切版本、启停都记一行）
```

`current` 是唯一被启动命令引用的路径，所以 `start` 的 `cwd` 写 `current` 就行，
不用改配置就能换版本。

## 服务器配置

`/etc/airlock/deployer.json`：

```json
{
  "serverId": "srv-prod01",
  "kind": "linux",
  "maxArchiveBytes": 536870912,
  "apps": {
    "web": {
      "root": "/srv/apps/web",
      "keepReleases": 5,
      "runtime": {
        "start": { "command": "node", "args": ["server.mjs"], "cwd": "current", "timeoutMs": 20000 },
        "stop":  { "command": "node", "args": ["scripts/stop.mjs"], "cwd": "current", "timeoutMs": 20000 },
        "status":{ "command": "node", "args": ["scripts/status.mjs"], "cwd": "current", "timeoutMs": 10000 }
      },
      "health": {
        "url": "http://127.0.0.1:3000/health",
        "expectStatus": 200,
        "timeoutMs": 30000,
        "intervalMs": 500
      },
      "install": { "command": "npm", "args": ["ci", "--omit=dev"], "timeoutMs": 300000 },
      "backupPaths": ["shared/data", "shared/config"],
      "keepBackups": 5,
      "restoreBackupOnRollback": false
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `serverId` | `srv-` 开头的标识，出现在状态输出里 |
| `kind` | `linux` / `windows`；缺省按当前系统推断。只影响链接类型 |
| `maxArchiveBytes` | 单个发布包上限，默认 512 MB |
| `apps.<id>.root` | 应用根目录；相对路径按配置文件所在目录解析 |
| `runtime.start` | 必需。激活时执行的启动命令，`shell:false` + 参数数组 |
| `runtime.stop` | 可选。不给就表示不需要优雅停止 |
| `runtime.status` | 可选。只用于状态展示，不参与发布决策 |
| `health.url` / `health.command` | 轮询探活；两个都给时优先 `url` |
| `install` | 解压后、激活前跑一次（装依赖、编译），在版本目录里执行 |
| `backupPaths` | 相对 root 的目录，激活前打包；空表示只回代码 |
| `keepReleases` | 保留多少个版本目录，默认 5；当前在用的永远不删 |
| `restoreBackupOnRollback` | 回滚时是否默认恢复数据，默认 `false` |

命令对象里的 `cwd` 只能是 `current` 或 `root`，不接受任意路径——否则路径注入面又打开了。

## Windows 裸进程托管：四个真机才暴露的坑

这四条是 2026-11-10 在 Windows Server 2025 上跑真机发布时踩出来的，本机隔离测试全部通过也发现不了。

**1. 进程会被 SSH 会话带走。**
用 `Start-Process` 启动的服务，SSH 一断就被回收（sshd 用 job object 清理进程树）。表现很迷惑：
发布时健康检查 `HTTP 200` 通过，发布结束几秒后端口就没了。本机测试用的是同步命令，进程活在
测试函数里，所以永远看不到这一层。

解决：用 Task Scheduler 启动，进程归属调度器而不是 SSH 会话。

```cmd
@echo off
schtasks /create /tn myapp-start /tr "C:\nodejs\node.exe C:\apps\myapp\current\server.mjs" /sc once /st 00:00 /ru SYSTEM /f >nul 2>&1
if errorlevel 1 exit /b 2
schtasks /run /tn myapp-start >nul 2>&1
exit /b %errorlevel%
```

**2. 非管理员账号起不了会话外进程。**
`ag-ssh` 这类受限账号调用 `Win32_Process.Create` 会直接「拒绝访问」，`Start-Process` 又会被清理。
所以「最小权限部署账号 + 裸进程托管」在 Windows 上必须**预注册**：管理员建一次任务或服务，
agent 只负责触发。想让 agent 自己起进程，它就只能是管理员——这是 Windows 的边界，不是工具的。

**3. 可执行文件路径别用正斜杠。**
`C:/Windows/System32/cmd.exe` 交给 `spawn` 时，`cmd.exe` 会报「命令语法不正确」。工具已经把
`command` 里的 `/` 归一成 `\`，但配置里直接写反斜杠更省事。注意只规范化命令本身，`args` 里
带 URL 的值不会被改。

**4. `.cmd` 必须是 CRLF。**
用 LF 换行的批处理，`cmd.exe` 同样报「命令语法不正确」。Windows 上的 `.cmd`/`.bat` 一律 CRLF + ASCII。

一个能用的最小应用的启动脚本（`start.cmd`，放 `C:\airlock\bin\`，不随版本发布）：

```cmd
@echo off
schtasks /create /tn myapp-start /tr "C:\nodejs\node.exe C:\airlock\apps\myapp\current\server.mjs" /sc once /st 00:00 /ru SYSTEM /f >nul 2>&1
if errorlevel 1 exit /b 2
schtasks /run /tn myapp-start >nul 2>&1
if errorlevel 1 exit /b 3
exit /b 0
```

对应的 `stop.ps1`（读应用根的 `app.pid` 杀进程）：

```powershell
$pidFile = 'app.pid'
if (-not (Test-Path $pidFile)) { exit 0 }
$target = [int]((Get-Content $pidFile -Raw).Trim())
Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
```

应用自己负责把 pid 写到应用根。注意 `current` 是 junction，`import.meta.url` 拿到的是链接路径，
要先 `realpathSync` 再往上退两级：

```js
const here = realpathSync(fileURLToPath(import.meta.url));
const appRoot = join(dirname(here), '..', '..');  // releases/<ver> -> 应用根
writeFileSync(join(appRoot, 'app.pid'), String(process.pid));
```

## SSH 门禁

和 broker 一样，用 `ForceCommand` 或 `authorized_keys` 的 `command=` 把它钉死：

```
Match User airlock-deploy
    ForceCommand /usr/bin/node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json
    PermitTTY no
    AllowTcpForwarding no
    PermitTunnel no
    AuthenticationMethods publickey
```

```
restrict,command="/usr/bin/node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json" ssh-ed25519 AAAA...
```

服务器需要 Node ≥ 24（直接从 `.ts` 跑，靠内置类型剥离），以及 `tar` 依赖（`npm ci` 会装）。

## 本机档案

`config/deploy-profiles.json`（已在 `.gitignore` 里，不会误提交）：

```json
{
  "default": "prod",
  "profiles": {
    "prod": {
      "host": "ssh.example.com",
      "user": "airlock-deploy",
      "port": 22,
      "identityFile": "C:/Users/you/.ssh/airlock-deploy",
      "hostKeyChecking": "yes",
      "serverId": "srv-prod01",
      "deployerCommand": "node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json",
      "workspace": "C:/work/my-web"
    }
  }
}
```

`workspace` 是默认打包目录。也可以用环境变量 `AIRLOCK_DEPLOY_PROFILES` 内联整张表。

## 日常操作

```bash
# 看服务器上跑的是什么、健康不健康
node bin/airlock-deploy.mjs status --app web
node bin/airlock-deploy.mjs status --app web --probe     # 现场探活

# 发布：先自己跑完 build 和测试，再让工具推上去
npm run build && npm test
node bin/airlock-deploy.mjs release --app web --source ./dist

# 回滚到上一个已部署版本
node bin/airlock-deploy.mjs rollback --app web

# 回滚到指定版本，连数据一起恢复
node bin/airlock-deploy.mjs rollback --app web --to 20261108-090000-9f8e7d6 --restore-backup

# 版本列表、发布日志
node bin/airlock-deploy.mjs list --app web
node bin/airlock-deploy.mjs logs --app web --lines 50
```

`release` 做的事，按顺序：

1. 打包本地目录（默认排除 `.git`、`node_modules`、`dist` 等，可 `--exclude` 追加）
2. 算每个文件的 sha256 与全树摘要
3. 通过 SSH 传给服务器，服务器解压到 `releases/<version>.tmp`
4. 重算摘要并与本机比对，不一致就整个目录删掉
5. 跑 `install` 命令（若有）
6. rename 成正式版本目录
7. `stop` → 切 `current` → `start` → 轮询健康检查
8. 起不来或健康检查超时：自动切回上一版并重启，然后报 `START_FAILED` / `HEALTH_FAILED`

版本号默认是 `YYYYMMDD-HHmmss-<git短哈希>`，也可以 `--version` 自己指定（1-64 位字母数字与 `. _ -`）。

## 回滚语义

| 场景 | 结果 |
|---|---|
| 发布后服务起不来 | 自动切回上一版，`state.json` 里新版本记 `failed` |
| 人工 `rollback` | 切到上一个 `deployed` 版本，被替掉的版本记 `rolled_back` |
| `--restore-backup` | 额外把目标版本的发布前数据快照解回去 |
| 目标版本目录被手动删了 | `VERSION_NOT_FOUND`，不会猜 |

**只回代码不等于回滚成功**：数据库有不可逆迁移时，旧代码打不开新库。所以数据恢复必须显式开启
（`--restore-backup` 或配置 `restoreBackupOnRollback: true`），工具不会替你决定。

备份文件命名对应「激活这个版本之前的数据」，回滚到版本 X 时恢复的是 X 那会儿发布前的快照。
自动清理只删版本目录，不删备份。

## MCP

```json
{
  "mcpServers": {
    "airlock-deploy": {
      "command": "node",
      "args": ["C:/Users/<user>/Desktop/Airlock/bin/airlock-deploy-mcp.mjs"],
      "env": { "AIRLOCK_DEPLOY_PROFILE": "prod" }
    }
  }
}
```

暴露 5 个工具：`deploy_status` / `deploy_list_versions` / `deploy_release` / `deploy_rollback` / `deploy_logs`。
模型能指定「发哪个应用、用哪个本地目录」，但给不了命令、路径或服务名。

## 安全边界

1. **请求侧不提交命令**：`start` / `stop` / `install` / 健康检查全部来自服务器本地配置。
2. **路径不受请求控制**：应用根、版本目录、备份路径都从配置派生；版本号过正则校验，
   归档解压时拒绝绝对路径与 `..`，展开大小与条目数有上限。
3. **内容有校验**：解压后按同一算法重算摘要，与包不符就整包作废，不留半截版本。
4. **切换是显式的**：`current` 是唯一入口，任何换版本都留下 `state.json` 记录与日志。
5. **失败不留死状态**：起不来就切回上一版并重启；没有上一版时如实报「服务可能仍停止」。

## 已验证 / 未验证

已验证（本机隔离测试 + 真实服务器）：

- 打包与解包、摘要一致性、路径穿越与展开上限拒绝（`test/deploy-archive.test.mjs`）
- 协议行与二进制混读、跨 chunk 边界（`test/deploy-protocol.test.mjs`）
- install / activate / rollback / 自动回退 / 版本冲突 / 数据备份恢复（`test/deploy-ops.test.mjs`）
- 命令执行、超时、Windows 正斜杠路径、健康检查 URL/命令探针（`test/deploy-runtime.test.mjs`）
- **真机（Windows Server 2025 / Node 24.22 / OpenSSH）**：`provision-windows.ps1` 建账号、
  `ForceCommand` 门禁生效（受限账号只能跑 deployer）、发布 v1、发布 v2 平滑切换、
  发坏版本触发 `HEALTH_FAILED` 并自动切回、手动 `rollback` 回上一版、
  `state.json` 历史与 `deploy.log` 记录正确

未验证：

- 真实服务器的 Linux 分支（`symlink` + systemd），本机是 Windows，只验了 junction
- 大包（几百 MB）在慢链路下的传输稳定性
- 多应用并发发布（工具不提供锁，靠运维约定）
- 带数据库迁移的回滚（本工具只管文件，migration/schema 兼容要自己保证）
- 受限账号在 Windows 上完整托管裸进程（需预注册任务或服务，见上面第 2 条）
