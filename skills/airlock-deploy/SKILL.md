---
name: airlock-deploy
description: 用 Airlock 把本地构建产物发布到远程服务器并支持版本回滚。触发词：发布到服务器、发版、部署到服务器、上线、回滚、回退版本、查看服务器版本、服务器跑的是哪一版、airlock-deploy、airlock release、发布失败、健康检查不过、新服务器接入、部署账号、sshd ForceCommand、current 链接、改发布目录、多服务器、发布到测试机。
whenToUse: 要把本地代码或构建产物推到远程 Windows/Linux 服务器、查看或回滚服务器版本、给新服务器接发布能力、改服务器上的发布落点时。
---

# Airlock 发布与回滚

把「本地构建好的目录」推到服务器：版本目录 + `current` 链接切换，起不来自动切回上一版。
工具只做分发，不跑构建——构建和测试是使用者自己的事。

## 何时使用

- 要把本地某个项目发布到远程服务器（网页服务、游戏服、任意 Node/静态产物）
- 要查服务器当前跑的是哪个版本、有哪些历史、失败原因是什么
- 要手动回滚到上一版或指定版本
- 要给一台新服务器接上发布能力
- 要改服务器上的发布落点（`root`）
- 同一份代码要发到不同机器（测试机 / 正式机）

**不要用它做**：远程改文件（那是 `airlock` 的 remote-dev 通道）、跑任意命令、管数据库。

## 快速命令

已全局安装时任何目录可用；没装就用 `node <Airlock目录>/bin/airlock-deploy.mjs`。

```powershell
airlock-deploy status --app <应用>            # 当前版本、历史、一致性
airlock-deploy status --app <应用> --probe    # 现场探活
airlock-deploy release --app <应用> --source <已构建目录>
airlock-deploy release --app <应用> --source <目录> --version v1.2.3
airlock-deploy rollback --app <应用>              # 回上一版
airlock-deploy rollback --app <应用> --to <版本>   # 回指定版
airlock-deploy logs --app <应用> --lines 50
airlock-deploy ui --app <应用>                # 本地 Web 控制台
airlock-deploy mcp                            # 给 MCP 客户端的 stdio 服务
```

多服务器时加 `--server <名字>`，用哪个连哪台。

## 发布流程

1. **本地构建 + 测试**（工具不管这段）
2. **发布**
   ```powershell
   airlock-deploy release --app web --source .\dist
   ```
   做的事：打包 → 算每个文件 sha256 → SSH 上传 → 解压到 `releases/<版本>.tmp` →
   重算摘要比对 → 跑 install 命令 → 转正 → `stop` → 切 `current` → `start` → 轮询健康检查
3. **看结果**：返回里的 `activated.health.ok` 必须为 `true`。
   失败会自动切回上一版并重启，同时报 `START_FAILED` / `HEALTH_FAILED`。
4. **确认服务真的活着**（别只信返回）：过几秒再 `status --probe`。

## 版本与状态在哪

```
<应用根>/
├── releases/<版本>/        每次发布一个目录
├── current -> releases/…   正在跑的版本（Linux 符号链接 / Windows junction）
├── backups/<版本>.tar.gz   发布前数据快照（配置了 backupPaths 才有）
├── state.json              当前版本 + 历史 + 失败原因
└── deploy.log              发布日志
```

`state.json` 的 `history[].status`：`deployed` / `failed` / `rolled_back` / `installed`。
`status` 输出里的 `consistent` 为 false 表示「记录说的版本」和「磁盘 current 指向的版本」不一致，
这时先去服务器看 `current` 实际指向哪，不要盲目再发。

## 多项目与多服务器

本机档案分三层，**先读档案再动手**，不要假设只有一台机器：

```json
{
  "servers": {
    "prod":    { "host": "...", "user": "...", "identityFile": "...",
                 "serverId": "srv-prod01", "deployerCommand": "..." },
    "staging": { "host": "...", "user": "...", "identityFile": "...",
                 "serverId": "srv-stage01", "deployerCommand": "..." }
  },
  "profiles": {
    "web-prod": { "server": "prod",    "app": "web", "workspace": "<本地目录>" },
    "api-prod": { "server": "prod",    "app": "api", "workspace": "<本地目录>" }
  }
}
```

- `servers` 是机器清单，`profiles` 是项目。一个 profile 指向一台机器上的一个 app。
- 同一份代码发到两台机器：给两个 profile，`app` 相同、`server` 不同。
- 服务器上同名 app 的落点由那台机器的 `deployer.json` 决定，两台机器可以不一样。
- 档案每个请求前都会重读，改了不用重启控制台。
- 查找顺序：`--profiles` > `AIRLOCK_DEPLOY_PROFILES_FILE` > `AIRLOCK_DEPLOY_PROFILES`（内联 JSON）
  > `~/.airlock/deploy-profiles.json` 与 `./config/deploy-profiles.json` 合并（同名以项目内为准）。
- ⚠️ 前三项是「只读这一份」，会**关掉合并**：设了 `AIRLOCK_DEPLOY_PROFILES_FILE` 之后，
  项目内 `config/deploy-profiles.json` 里的项目会凭空消失且没有报错。
  发现「项目少了」先查这三个来源，别怀疑档案被删了。

## 改服务器上的落点

落点就是 `deployer.json` 里该应用的 `root`，决定 `releases/`、`backups/`、`current` 放在哪。

两个 op：`list-dir`（列服务器目录）和 `set-root`（改落点）。控制台上是「落点」旁边的「改」按钮。

三条硬规则：

1. **只改 `root`**，`runtime` / `health` / `backupPaths` 原样保留。
2. **旧目录里的版本不搬**。改完新目录是空的，`current` 变 `null`，必须重新发一版。
3. **拒绝盘根与系统目录**（`C:\`、`C:\Windows`、`/etc`、`/usr`）。

改之前先备份服务器配置。Windows 上默认落点是管理员桌面 `C:\Users\Administrator\Desktop`。

⚠️ **改落点后要检查启动脚本**：被 Task Scheduler 直接调用的脚本（如 `mc-launch.cmd`）在
`bin\` 下，拿不到 `cwd`，只能把 root 写死。不改它的话服务会从**旧目录**被拉起来——
表现是「端口在监听，但新落点看不到日志、`current` 和实际进程对不上」。

## 服务器侧配置要点

`deployer.json` 里每个应用的关键字段：

| 字段 | 必须 | 注意 |
|---|---|---|
| `root` | 是 | 应用根，`releases/`、`current` 都在它下面 |
| `runtime.start` | 是 | **必须启动后就返回**，否则 deployer 会卡到超时 |
| `runtime.stop` | 否 | 不给就跳过停止步骤 |
| `health` | 强烈建议 | 没配的话起不来的版本也会被当成功 |
| `install` | 否 | 解压后、激活前跑（npm ci 等），cwd 是版本目录 |
| `backupPaths` | 否 | 相对 root 的目录，发布前打包 |
| `keepReleases` | 否 | 默认 5，当前版本永不删 |

## 有状态服务（游戏服这类）

发布包解出的是**干净目录**，所以不能把存档放里面——一发版就清空。做法：

- 世界/数据放 `<root>/shared/`，`backupPaths: ["shared"]`，`restoreBackupOnRollback: true`
- `install` 钩子里在版本目录建 junction 指向 `shared/world`，并写 `eula.txt`、复制配置
- `start` 用 Task Scheduler / systemd 托管，脚本里用 `%CD%` 或显式 `cd` 到 `current`

模板见仓库 `examples/windows/mc/`。

停止这类服务通常是**非优雅的**（无窗口的 JVM 收不到 `WM_CLOSE`，`taskkill` 不带 `/F` 无效），
最后几秒的写入可能丢。要优雅就开 RCON 发 `stop`，别指望 `taskkill`。

## 控制台

`airlock-deploy ui --app <应用>` 起一个只绑 `127.0.0.1` 的本地页面：

- 切项目 / 切服务器（右上角两个下拉）
- 看本地 git 提交、服务器版本历史、`deploy.log`
- 发布（自动探测 `dist` / `build` / `out` 等候选目录）
- 回滚指定版本
- 改服务器落点（服务器端目录浏览器）

用途：让人自己发版，或让 agent 通过 HTTP 接口操作（要带 `x-airlock-token`）。

## 失败模式

| 现象 | 原因 | 处理 |
|---|---|---|
| `Permission denied (publickey)` | key 不在账号的真实 profile 目录；或账号不在 `AllowGroups` / `AllowUsers` | Windows 的 profile 是 `C:\Users\<用户>.<机器名>`，查 `ProfileList`；组白名单在 `sshd_config` |
| ssh 连不上但 3389 通 | 云安全组没放行 22 | 要机器主人在云控制台开，agent 开不了 |
| 服务显示 Running 但 22 不通 | Windows 防火墙规则 `OpenSSH-Server-In-TCP` 被禁用，或只覆盖 Private | 启用并覆盖实际使用的配置文件 |
| ssh 能连但 deployer 报「不是内部或外部命令」 | Node 不在 PATH | 用绝对路径（`where node` 查） |
| `START_FAILED: 命令语法不正确` | 可执行文件路径用了正斜杠；或 `.cmd` 是 LF 换行 | 路径改反斜杠，`.cmd` 存 CRLF |
| `START_FAILED` 超时 | start 命令阻塞（HTTP 服务不退出） | Windows 用 `schtasks` 起、Linux 用 systemd |
| 健康检查通过，几秒后服务没了 | `Start-Process` 起的进程被 SSH 会话回收 | 用 Task Scheduler / 服务 / CIM 启动 |
| `拒绝访问`（CIM 创建进程） | 账号不是管理员 | 提权，或预注册任务让账号只触发 |
| `VERSION_EXISTS` | 同版本号重复发布 | 换版本号，或先删 `releases/<版本>` |
| `HEALTH_FAILED` 且没有上一版 | 首次发布就失败 | 看 `deploy.log`、手动确认 start 命令 |
| 换网络后连不上 | 来源 IP 白名单 | 从 RDP/控制台改防火墙规则加新 IP |
| `consistent: false` | 有人手动改过 `current` 链接 | 查磁盘实际指向，确认后再决定 |
| 改落点后服务没换 | 启动脚本写死了旧 root | 见「改服务器上的落点」的警告 |

## 确认你的环境

**不要凭记忆答，先查**：

```powershell
airlock-deploy status --app <应用>      # root、current、consistent、服务器 id 全在返回里
node -e "console.log(require('os').homedir())"    # 你的家目录
```

- Airlock 装在哪：`where airlock-deploy`，或看 `bin/airlock-deploy.mjs` 的真实路径
- 档案用哪份：`--profiles` 参数、`AIRLOCK_DEPLOY_PROFILES_FILE` 环境变量、或默认的两份合并
- 服务器上代码在哪：`status` 返回的 `root`；`deployer.json` 一般在 `<部署根>/config/`
- 部署账号叫什么：档案里的 `user`

## 交付前自检

1. `airlock-deploy status --app <应用>` 能返回，`consistent: true`
2. 发布返回 `activated.health.ok === true`
3. 过 5 秒再查一次，服务还在（`status --probe`）
4. 首次接入某台机器时，发一次故意坏的版本，确认自动回退生效
5. 回滚后 `current` 指向正确版本
