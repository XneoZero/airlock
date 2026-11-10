# Airlock

**A capability airlock for agents.** A narrow, auditable SSH channel to a server workspace —
only registered operations pass, and every pass is logged.

给 agent 的「能力气闸」：一条窄的、可审计的 SSH 服务器通道。模型只能执行登记过的操作，
不能拿到任意 shell；写入带哈希校验与幂等键，并发写由租约保护。

---

## 它是什么

一台服务器上运行一个小型 Broker，本机通过 `ssh` 把它的 stdin/stdout 接到一个
JSON Lines 协议上。模型（经 CLI 或 MCP）只能调用 12 个固定 op：

| 类别 | op | 说明 |
|---|---|---|
| 读 | `status` | 服务器身份、工作区、版本、当前租约 |
| 读 | `list` | 列工作区文件（有上限） |
| 读 | `read` | 读文本文件（默认 256KB 上限） |
| 读 | `git-status` / `git-diff` | 固定参数的 git 查询 |
| 写 | `lease-acquire` / `lease-release` | 单写者租约，默认 30 分钟 |
| 写 | `apply` | 写入文件：`expectedHash` 乐观并发 + `operationId` 幂等 |
| 执行 | `check` | 只能跑配置里预注册的任务名，`shell:false` |
| 执行 | `job-status` / `job-cancel` | 查询、取消预注册任务 |
| 发布 | `release-request` | 冻结内容摘要与检查记录，交给外部审批 |

另有 `host-runtime` 端口：4 个预注册服务槽位（`app` / `worker` / `scheduler` / `gateway`）
与 3 个动作（`restart` / `reload` / `status`）。请求侧只能给槽位 id，不能给命令或单元名。

## 它不是什么

- 不是 SSH 的替代品，不是 Ansible，不是通用运维通道。
- 不执行任意命令、不提供交互式 PTY、不管理数据库、不 `tail -f` 日志。
- 不托管凭据：私钥在本机 ssh agent 或受保护文件里，profile 只存路径。
- 不包含发布执行侧：`release-request` 只写一份冻结申请，部署与回滚由外部审批系统负责。

## 架构

```
agent / MCP client
        │  stdio (MCP)
        ▼
  bin/airlock-mcp.mjs ──┐
  bin/airlock.mjs ──────┤  ssh -T -o BatchMode=yes
                        ▼
              sshd (restrict + ForceCommand)
                        │  stdin/stdout
                        ▼
              bin/airlock-broker.mjs
              ├─ JSON Lines 协议（1MB/行，版本不符直接拒）
              ├─ 路径白名单 + realpath 校验
              ├─ CAS 写入 + operationId 幂等记录
              ├─ 单写者租约（stateDir/lease.json）
              ├─ 预注册任务（shell:false，输出 8000 字符上限）
              └─ release-inbox（冻结哈希 + 检查记录）
```

## 快速开始

### 1. 服务器侧：Broker 配置

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
    "test": { "command": "npm", "args": ["test"], "timeoutMs": 600000 },
    "build": { "command": "npm", "args": ["run", "build"], "timeoutMs": 600000 }
  }
}
```

`root` 是唯一可读写的工作区；`stateDir` 与 `releaseInbox` 必须位于工作区之外。
`tasks` 里没有登记的名字，`check` 一律拒绝。完整示例见 `examples/broker.example.json`。

### 2. 本机：profile

```json
{
  "default": "dev",
  "profiles": {
    "dev": {
      "serverId": "srv-dev01",
      "host": "ssh.example.com",
      "user": "airlock-dev",
      "port": 22,
      "identityFile": "~/.ssh/airlock-dev",
      "brokerCommand": "node /opt/airlock/bin/airlock-broker.mjs --config /opt/airlock/config/broker.json",
      "hostKeyChecking": "yes"
    }
  }
}
```

profile 只放连接信息，不放私钥内容；脚本会拒绝含 `password` / `privateKey` / `token`
之类字段的 profile。表放在 `config/remote-profiles.json`，或用 `AIRLOCK_PROFILES` 内联。
完整示例见 `examples/remote-profiles.example.json`。

### 3. CLI

```bash
node bin/airlock.mjs status
node bin/airlock.mjs list --path src
node bin/airlock.mjs read --path package.json
node bin/airlock.mjs apply --path src/a.ts --expected-hash <hash|none> --operation-id op-0001 --content-file a.ts
node bin/airlock.mjs check --task test
node bin/airlock.mjs job-status --job job-xxxx
```

### 4. MCP

```bash
node bin/airlock.mjs mcp          # 或 AIRLOCK_PROFILE=dev node bin/airlock-mcp.mjs
```

暴露 10 个工具：`remote_status` / `remote_list` / `remote_read` / `remote_apply` /
`remote_git_status` / `remote_git_diff` / `remote_check` / `remote_job_status` /
`remote_job_cancel` / `remote_release_request`。

## 安全模型

1. **路径**：先过语法白名单（拒绝绝对路径、`..`、NUL），再 `resolve` + 带分隔符的前缀比较，
   最后对落点 `realpath`——挡住指向工作区外的符号链接。
2. **并发**：`apply` 必须持有效租约；`expectedHash` 不匹配就 `HASH_MISMATCH`，
   不会覆盖别人的修改。
3. **幂等**：`operationId` 落在 `stateDir`，重启后同一次重试不会产生第二次写入。
4. **执行**：`check` 只认预注册任务名，`shell:false`，参数数组固定，输出有上限。
5. **失败**：Broker 只回错误码，不回堆栈；未预期异常一律 `INTERNAL`。

## 与 ssh-mcp 类项目的关系

社区主流是「把 shell 交给模型」，再用正则白名单或审批做补救。Airlock 反过来：
**默认没有 shell**，能力面由 op 决定，策略在服务器侧强制执行，不在模型侧拦截。
代价是表达力——没预注册的排障要等人扩任务。这是有意的取舍。

## 目录结构

```
src/contracts/        协议契约（zod schema、错误码）
src/transports/remote-dev/   Broker / client / 协议 / 工作区 / 任务 / MCP
src/transports/host-runtime/ systemd / Windows service 的预注册动作
bin/                  CLI、MCP 入口、服务器侧 Broker
test/                 隔离测试（临时目录 + 本机 node 进程）
```

## 开发与测试

需要 Node.js >= 24（直接运行 TypeScript，无需构建）。

```bash
npm install
npm test
npm run typecheck
```

测试不连服务器、不读 `config/`、不发送消息。

## 状态

- 已用隔离测试覆盖：协议编解码、Broker 路径/CAS/租约/任务白名单、客户端超时与错误码、
  工作区写入原子性与符号链接拒绝、宿主动作白名单。
- 未验证：真实服务器的 sshd `ForceCommand` 链路、跨平台（Windows OpenSSH）专项、
  多客户端并发、发布执行侧。

## 许可

MIT
