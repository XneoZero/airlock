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
4. 把公钥写进 `C:\Users\ag-ssh\.ssh\authorized_keys` 并收紧 ACL
5. 往 `sshd_config` 追加 `Match User ag-ssh` + `ForceCommand C:\airlock\bin\deploy.cmd`，
   禁用 PTY/转发；**先备份、用 `sshd -t` 校验、校验失败自动还原**

`deploy.cmd` 是个两行包装：调用 `node C:\airlock\bin\airlock-deployer.mjs --config C:\airlock\config\deployer.json`。
Windows 的 `ForceCommand` 会交给 `cmd.exe` 解析，路径里有空格（`C:\Program Files\nodejs`）时
直接写容易翻车，包一层 `.cmd` 最稳。

> 本机侧要改的只有一处：`config/deploy-profiles.json` 里的 `user` 字段。账号叫什么、几台服务器
> 各用什么账号，全在档案里配，代码里没有硬编码。

Linux 上这一步等价于在 `~/.ssh/authorized_keys` 那行前面加前缀，不需要改 sshd_config：

```
restrict,command="/usr/bin/node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json" ssh-ed25519 AAAA...
```

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

已验证（本机隔离测试 + 真实进程端到端）：

- 打包与解包、摘要一致性、路径穿越与展开上限拒绝（`test/deploy-archive.test.mjs`）
- 协议行与二进制混读、跨 chunk 边界（`test/deploy-protocol.test.mjs`）
- install / activate / rollback / 自动回退 / 版本冲突 / 数据备份恢复（`test/deploy-ops.test.mjs`）
- 起真实 `airlock-deployer.mjs` 进程，走真实协议跑完发布、回滚、失败回退

未验证：

- 真实 sshd 的 `ForceCommand` 链路（本机用直接调用 deployer 代替）
- Linux 符号链接与 Windows junction 之外的特殊挂载（网络盘、只读卷）
- 大包（几百 MB）在慢链路下的传输稳定性
- 多应用并发发布（工具不提供锁，靠运维约定）
- 带数据库迁移的回滚（本工具只管文件，迁移脚本与 schema 兼容要自己保证）
