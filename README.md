# Airlock

**A capability airlock for agents.** Narrow, auditable SSH channels to a server —
only registered operations pass, and every pass is logged.

给 agent 的「能力气闸」：通往服务器的窄通道。模型只能执行登记过的操作，拿不到任意 shell。
两个通道，方向相反：

| 通道 | 方向 | 用途 |
|---|---|---|
| `remote-dev` | 读写服务器上的工作区 | 让 agent 看代码、改文件、跑预注册的检查 |
| `deploy` | 本地构建产物 → 服务器 | 发版、切版本、失败自动回滚 |

---

## 它是什么

两台机器之间只跑一条 SSH 连接，stdin/stdout 接一个 JSON Lines 协议。请求侧说得越少，
能被滥用的面就越小：

- **`remote-dev`** 只开放 12 个固定 op：读（`status` / `list` / `read` / `git-status` / `git-diff`）、
  写（`lease-acquire` / `lease-release` / `apply`）、执行（`check` / `job-status` / `job-cancel`）、
  交接（`release-request`）。另有 `host-runtime` 端口：4 个服务槽位 + 3 个动作（`restart` / `reload` / `status`），
  请求侧只能给槽位 id，不能给命令或单元名。
- **`deploy`** 只认「应用 id + 版本号 + 归档」：启停命令、健康检查、目录结构全部来自服务器本地配置，
  本机传不了命令进服务器。

## 它不是什么

- 不是 SSH 的替代品，不是 Ansible，不是通用运维通道。
- 不执行任意命令、不提供交互式 PTY、不管理数据库、不 `tail -f` 日志。
- 不托管凭据：私钥在本机 ssh agent 或受保护文件里，profile 只存路径。
- 不负责构建：`deploy` 推的是**已经构建好的目录**，构建是调用方的事。

## 架构

```
agent / MCP client                         本地
        │  stdio (MCP)                        │
        ▼                                     │  npm run build（你自己）
  bin/airlock-mcp.mjs ──┐                     │
  bin/airlock.mjs ──────┤  ssh -T -o BatchMode=yes
  bin/airlock-deploy.mjs┘                     │
                        │                     │
                        ▼                     │
              sshd (restrict + ForceCommand)  │
                        │  stdin/stdout       │
                        ▼                     │
        bin/airlock-broker.mjs  或            │
        bin/airlock-deployer.mjs              │
        ├─ JSON Lines 协议（版本不符直接拒）  │
        ├─ 路径白名单 + realpath 校验         │
        ├─ 版本目录 + current 链接            │
        └─ 状态、日志、数据快照               │
```

## 快速开始

需要 **Node.js ≥ 24**：直接运行 TypeScript，靠内置类型剥离，没有构建步骤。

```bash
git clone <your-repo> airlock && cd airlock
npm install
npm test            # 75 个测试，不连服务器、不读 config/
npm run typecheck
```

### 通道一：`remote-dev`（改服务器上的文件）

服务器侧配置 `broker.json`：

```json
{
  "profileId": "prod",
  "serverId": "srv-prod01",
  "workspaceId": "ws-app",
  "root": "/opt/airlock/workspace",
  "stateDir": "/opt/airlock/state",
  "releaseInbox": "/opt/airlock/inbox",
  "writable": true,
  "tasks": {
    "test":  { "command": "npm", "args": ["test"], "timeoutMs": 600000 },
    "build": { "command": "npm", "args": ["run", "build"], "timeoutMs": 600000 }
  }
}
```

`root` 是唯一可读写的工作区；`stateDir` 与 `releaseInbox` 必须在工作区之外。
`tasks` 里没登记的名字，`check` 一律拒绝。完整示例见 `examples/broker.example.json`。

本机 profile：

```json
{
  "default": "dev",
  "profiles": {
    "dev": {
      "serverId": "srv-dev01",
      "host": "ssh.example.com",
      "user": "airlock-dev",
      "identityFile": "~/.ssh/airlock-dev",
      "brokerCommand": "node /opt/airlock/bin/airlock-broker.mjs --config /opt/airlock/config/broker.json",
      "hostKeyChecking": "yes"
    }
  }
}
```

profile 只放连接信息，不放私钥内容。完整示例见 `examples/remote-profiles.example.json`。

```bash
node bin/airlock.mjs status
node bin/airlock.mjs list --path src
node bin/airlock.mjs read --path package.json
node bin/airlock.mjs apply --path src/a.ts --expected-hash <hash|none> --operation-id op-0001 --content-file a.ts
node bin/airlock.mjs check --task test
```

MCP（暴露 10 个 `remote_*` 工具）：

```bash
node bin/airlock.mjs mcp
```

### 通道二：`deploy`（本地构建产物 → 服务器）

```bash
npm run build                                                    # 先自己验证
airlock-deploy release --app web --source ./dist                 # 打包 → 上传 → 切版本 → 重启 → 探活
airlock-deploy rollback --app web                                # 切回上一版，起不来会自己退回来
airlock-deploy status  --app web --probe                         # 现在跑的是哪版、健康不健康
```

服务器侧目录：

```
/srv/apps/web/
├── releases/<版本>/        每次发布一个目录，解压后原样保存
├── current -> releases/…   正在跑的版本（Linux 符号链接 / Windows junction）
├── backups/<版本>.tar.gz   发布前数据快照（配置了 backupPaths 才有）
├── state.json              当前版本 + 历史
└── deploy.log              每次切版本、启停都记一行
```

三条纪律：请求侧只提交「应用 id + 版本号 + 归档」；包解压后在服务器重算摘要，对不上整包作废；
切换前后都落 `state.json` 与日志，失败如实写 `failed` 并自动回退到上一版。

配置、回滚语义、数据备份细节见 [docs/DEPLOY.md](docs/DEPLOY.md)；
从零接入一台新服务器见 [docs/ONBOARDING.md](docs/ONBOARDING.md)。

## 控制台

不想敲命令时：

```bash
airlock-deploy ui --app web
# 控制台已启动：http://127.0.0.1:7788/?t=xxxx
```

纯本地服务（只绑 `127.0.0.1`，一次性 token 进 URL），一个页面做四件事：

- **切项目 / 切服务器**：同一份代码可以推到测试机和正式机，不用配两份档案
- **看**：本地 git 提交、服务器上的版本历史、`deploy.log`
- **发**：选本地构建产物目录（自动探测 `dist` / `build` / `out` 等）→ 发布
- **退**：点某个版本回退，或改服务器上的发布落点

落点（`root`）可以直接在控制台改：点「落点」后面的「改」，走服务器端目录浏览器，
默认停在管理员桌面。改完下一次请求就生效，旧目录里的版本不会自动搬过去。

### 多项目与多服务器

档案分三层：

```json
{
  "default": "web-prod",
  "servers": {
    "prod":    { "host": "ssh.example.com", "user": "airlock-deploy", "identityFile": "~/.ssh/k1",
                 "serverId": "srv-prod01", "deployerCommand": "node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json" },
    "staging": { "host": "10.0.0.12", "user": "deploy", "identityFile": "~/.ssh/k2",
                 "serverId": "srv-stage01", "deployerCommand": "..." }
  },
  "profiles": {
    "web-prod":    { "server": "prod",    "app": "web", "workspace": "~/work/my-web" },
    "api-prod":    { "server": "prod",    "app": "api", "workspace": "~/work/my-api" },
    "web-staging": { "server": "staging", "app": "web", "workspace": "~/work/my-web" }
  }
}
```

`servers` 是机器清单，`profiles` 是项目。控制台右上角的服务器下拉就是 `servers` 的键。
档案**每个请求前都会重读**，所以运行中改了档案，回控制台刷新就能看到新服务器，不用重启。

档案查找顺序：`--profiles` > `AIRLOCK_DEPLOY_PROFILES_FILE` > `AIRLOCK_DEPLOY_PROFILES`（内联 JSON）
> `~/.airlock/deploy-profiles.json` 与 `./config/deploy-profiles.json` **合并**（同名以项目内为准）。
老格式（把 `host` 直接内联在 profile 里）仍然可用。

### 接入新机器

新机器上要装 Node、建部署账号、改 sshd、写 `deployer.json`。控制台顶部「＋ 服务器」会把这一整套
写成一段提示词，复制给 agent 就行——里面带了本机实际路径、每步的验证要求和几个已知的坑
（Windows 防火墙规则、`AllowGroups` 白名单、profile 目录带机器后缀、ACL 别一刀切）。

平台相关的路径和措辞按运行控制台的操作系统生成，Windows / macOS / Linux 各按各的写。

## 安全模型

1. **路径**：先过语法白名单（拒绝绝对路径、`..`、NUL），再 `resolve` + 带分隔符的前缀比较，
   最后对落点 `realpath`——挡住指向工作区外的符号链接。
2. **并发**：`apply` 必须持有效租约；`expectedHash` 不匹配就 `HASH_MISMATCH`，不会覆盖别人的修改。
3. **幂等**：`operationId` 落在 `stateDir`，重启后同一次重试不会产生第二次写入。
4. **执行**：`check` 只认预注册任务名，`shell:false`，参数数组固定，输出有上限。
5. **失败**：只回错误码，不回堆栈；未预期异常一律 `INTERNAL`。
6. **发布落点**：只认服务器配置里的 `root`，客户端不能在请求里临时指定；改落点要走 `set-root`
   并拒绝盘根与系统目录。
7. **控制台**：只绑 `127.0.0.1`，所有 API 都要 URL 里的 token，防其它网页撞进来发版。

## 与 ssh-mcp 类项目的关系

社区主流是「把 shell 交给模型」，再用正则白名单或审批做补救。Airlock 反过来：
**默认没有 shell**，能力面由 op 决定，策略在服务器侧强制执行，不在模型侧拦截。
代价是表达力——没预注册的排障要等人扩任务。这是有意的取舍。

## 目录结构

```
src/contracts/                协议契约（zod schema、错误码）
src/transports/remote-dev/    Broker / client / 协议 / 工作区 / 任务 / MCP
src/transports/host-runtime/  systemd / Windows service 的预注册动作
src/deploy/                   发布通道：归档校验、版本状态、启停探活、落点管理
src/deploy/ui/                本地控制台（node:http + 单页 HTML，无前端构建）
bin/                          CLI、MCP 入口、服务器侧 Broker 与 deployer
docs/                         发布通道与接入流程
examples/                     各类配置示例，含 Minecraft 服务端模板
test/                         隔离测试（临时目录 + 本机 node 进程）
```

## 开发与测试

```bash
npm install
npm test              # node --test，全部隔离
npm run typecheck     # tsc --noEmit
```

测试不连服务器、不读 `config/`、不发消息。改代码时约定：

- 注释和提交信息用中文，代码标识符用英文。
- 报错信息写「为什么错 + 怎么办」，不要只回一个错误码。
- 不猜默认值：任何会影响服务器上真实文件的参数要么必填，要么有明确回退理由。

## 状态

已用隔离测试覆盖：协议编解码、Broker 路径 / CAS / 租约 / 任务白名单、客户端超时与错误码、
工作区写入原子性、宿主动作白名单、打包与摘要一致性、路径穿越、协议行与二进制混读、
`install` / `activate` / `rollback`、激活失败自动回退、数据备份恢复、落点校验与写回。

已用真实服务器端到端跑通：Windows + OpenSSH `ForceCommand` 的部署通道、版本切换与自动回滚、
多服务器切换、有状态服务（Minecraft Fabric 服务端：世界数据放在 `releases/` 之外，用 junction 持久化）。

未验证：Linux 服务器上的完整链路、多客户端并发、慢链路下的大包传输稳定性、
带数据库迁移的回滚、macOS 作为控制台宿主。

## 许可

MIT
