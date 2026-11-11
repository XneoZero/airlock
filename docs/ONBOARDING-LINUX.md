# 新服务器接入：Linux

Windows 的流程见 [ONBOARDING.md](ONBOARDING.md)。本文是 Linux 版，
基于 2026-11-11 一次真实的从零接入（OpenCloudOS 9.6 / Node 24.22 / OpenSSH 9.3 / systemd 255），
命令都是当场跑通的，坑也是当场踩的。

脚本已经把这套流程固化：`scripts/provision-linux.sh`。下面的步骤 4 用它，
步骤 5 之后才是应用自己的事。

---

## 0. 开工前

| 需要 | 说明 |
|---|---|
| 服务器 root 访问 | 云控制台 VNC 或密码 SSH。**必须**，因为门禁配好之前只能靠它 |
| 服务器公网 IP | 配 profile 用 |
| 本机一把专用私钥 | `ssh-keygen -t ed25519 -f ~/.ssh/ag_deploy_ed25519 -N "" -C ag-deploy` |
| 云安全组放行 22 | agent 开不了，要机器主人开 |

**先把公钥装进 root**，否则后面所有步骤都进不去：

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
printf '%s\n' 'ssh-ed25519 AAAA... ag-ssh-deploy' >> /root/.ssh/authorized_keys && \
chmod 600 /root/.ssh/authorized_keys
```

---

## 1. 体检

```bash
id -u; uname -sr; grep PRETTY /etc/os-release
systemctl --version | head -1
command -v curl xz tar; getenforce 2>/dev/null || echo 'no selinux'
ss -lntp | grep ':22'
```

**验证**：`id -u` 是 0；`/run/systemd/system` 存在（脚本会检查，容器里跑不了）。

**换过系统的机器**：主机的 host key 会变，本机 `known_hosts` 里那条旧记录会直接
挡住连接（`REMOTE HOST IDENTIFICATION HAS CHANGED`）。先清掉：

```powershell
ssh-keygen -R <IP>
```

> 在 DSH 这类沙箱会话里，`~/.ssh/known_hosts` 可读不可写，`ssh-keygen -R` 会报
> `mkstemp: Permission denied`。改用带 `-o UserKnownHostsFile=<可写路径>` 的临时文件，
> 或者让用户在普通终端里执行。

---

## 2. 装 Node ≥ 24

系统源里的 Node 通常是 18，不要用。用官方 linux-x64 构建：

```bash
curl -fsSL https://npmmirror.com/mirrors/node/index.json \
  | grep -o '"version"[[:space:]]*:[[:space:]]*"v24\.[0-9.]*"' | head -1
# 用上面拿到的版本号
curl -fsSL -o /tmp/node.tar.xz \
  "https://npmmirror.com/mirrors/node/v24.22.2/node-v24.22.2-linux-x64.tar.xz"
mkdir -p /opt && tar -xJf /tmp/node.tar.xz -C /opt
mv /opt/node-v24.22.2-linux-x64 /opt/nodejs
/opt/nodejs/bin/node -v
```

`provision-linux.sh --install-node` 会自动做这件事。

> **坑 1**：`/opt/nodejs` 不在 PATH 里。launcher、systemd 单元、`deployer.json` 里
> 一律写绝对路径 `/opt/nodejs/bin/node`。
>
> **坑 2**：`/opt/nodejs/bin/npm` 是 `#!/usr/bin/env node` 脚本，直接调用会报
> `env: 'node': No such file or directory`。要么 `PATH=/opt/nodejs/bin:$PATH npm`，
> 要么用绝对路径的 node 去跑 npm-cli.js。

---

## 3. 传 Airlock

本机打包（排除依赖、仓库配置和测试）：

```powershell
tar -czf "$env:TEMP\airlock-src.tar.gz" -C C:\path\to\Airlock `
    --exclude=node_modules --exclude=.git --exclude=config --exclude=test .
scp "$env:TEMP\airlock-src.tar.gz" root@<IP>:/tmp/airlock-src.tar.gz
```

服务器解压 + 装生产依赖：

```bash
mkdir -p /opt/airlock && tar -xzf /tmp/airlock-src.tar.gz -C /opt/airlock
cd /opt/airlock && PATH=/opt/nodejs/bin:$PATH \
  npm ci --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
/opt/nodejs/bin/node /opt/airlock/bin/airlock-deployer.mjs --help
```

**验证**：`node_modules` 里有 `tar` 和 `zod`。

---

## 4. 建部署账号 + sshd 门禁

```bash
./provision-linux.sh \
  --public-key 'ssh-ed25519 AAAA... ag-ssh-deploy' \
  --allow-systemctl airlock-demo \
  --install-node
```

脚本做四件事，全部幂等：

1. 建 `ag-ssh`（`useradd -m`，随后 `usermod -L` 锁密码，只能走密钥）
2. 写 `~ag-ssh/.ssh/authorized_keys`（600，属主是账号本人），重复的公钥去重
3. 写 launcher `/opt/airlock/bin/deploy.sh` → `exec <node> <deployer> --config <配置>`
4. 改 `sshd_config`：追加 `Match User ag-ssh` 块（`ForceCommand` + `PermitTTY no` +
   `AuthenticationMethods publickey`），`sshd -t` 通过才 reload；reload 之前先挂
   `systemd-run --on-active=600` 的自动回滚守卫

**验证 1**：门禁吃掉普通 shell 命令

```bash
echo whoami | ssh -i ~/.ssh/ag_deploy_ed25519 ag-ssh@<IP>
# 期望：{"v":1,"id":0,"ok":false,"error":{"code":"INVALID_REQUEST",...}}
```

**验证 2**：协议行能拿到状态

```bash
echo '{"v":1,"id":1,"op":"status"}' | ssh -i ~/.ssh/ag_deploy_ed25519 ag-ssh@<IP>
```

**验证 3**：root（或你的管理员账号）还能进

```bash
ssh -i ~/.ssh/ag_deploy_ed25519 root@<IP> 'echo ok'
```

三条都过了再取消守卫：

```bash
systemctl stop sshd-rollback.timer
```

> **坑 3（最容易翻车）**：手工改 `sshd_config` 加 `Match` 块时，**替换要连块一起**。
> 只删掉 marker 注释行会留下没有 marker 的孤儿 `Match` 块，sshd 仍然按**先出现的**
> `ForceCommand` 走，表现是「配置看着是新的，ag-ssh 却还在跑旧 launcher」。
> 脚本用 awk 从 marker 删到下一个顶层指令，并测过中间块、末尾块、重复块、
> `ag-ssh` 与 `ag-ssh2` 不互相误删这几种情形。
>
> **坑 4**：`ssh-keygen -R` 之外，手工追加的 marker 文案和脚本不再一致时，旧块不会被
> 认出来。脚本按前缀匹配账号名，所以换成 `# --- airlock deploy account: ag-ssh ---`
> 这种标准的就没事。

---

## 5. 配应用

`/etc/airlock/deployer.json`（参考 `examples/deployer.example.json`）：

```json
{
  "serverId": "srv-test01",
  "kind": "linux",
  "apps": {
    "demo": {
      "root": "/srv/apps/demo",
      "runtime": {
        "start": { "command": "sudo", "args": ["-n","systemctl","restart","airlock-demo"], "cwd": "current", "timeoutMs": 30000 },
        "stop":  { "command": "sudo", "args": ["-n","systemctl","stop","airlock-demo"], "cwd": "root", "timeoutMs": 30000 }
      },
      "health": { "url": "http://127.0.0.1:18080/health", "expectStatus": 200, "timeoutMs": 30000, "intervalMs": 500 }
    }
  }
}
```

三条硬要求：

1. **`start` 必须启动后就返回**——`systemctl restart` 满足；直接 `node server.mjs` 会把
   deployer 卡到超时。
2. **`health` 一定要配**——没有它，起不来的版本也会被当成发布成功。
3. **命令走 `sudo -n`**，权限由 `/etc/sudoers.d/airlock-ag-ssh` 精确白名单给，
   只放 `systemctl` 的 restart/stop/start/is-active/status，不给整台机器的 root。

systemd 单元（`/etc/systemd/system/airlock-demo.service`）：

```ini
[Unit]
Description=demo app (Airlock managed)
After=network.target

[Service]
Type=simple
User=ag-ssh
WorkingDirectory=/srv/apps/demo/current
ExecStart=/opt/nodejs/bin/node /srv/apps/demo/current/server.mjs
Restart=on-failure
RestartSec=2
StandardOutput=append:/srv/apps/demo/service.log
StandardError=append:/srv/apps/demo/service.log

[Install]
WantedBy=multi-user.target
```

应用根要归部署账号：

```bash
install -d -m 755 -o ag-ssh -g ag-ssh /srv/apps/demo
systemctl daemon-reload && systemctl enable airlock-demo
```

> **坑 5**：`WorkingDirectory` 指向 `current`，首次发布前这个符号链接不存在，
> 手写单元时别指望先 `systemctl start` 试跑。发布流程是「解包 → `stop` → 切 `current`
> → `start`」，顺序保证 `current` 在启动时已经就位。
>
> **坑 6**：应用的 `app.pid` 写在**应用根**（`releases/<ver>` 往上两级），部署账号要能
> 写那个目录，否则 `start` 里写 pid 会 `EACCES`。

---

## 6. 首次发布

本机 `~/.airlock/deploy-profiles.json`（或项目内 `config/deploy-profiles.json`）：

```json
{
  "servers": {
    "srv-test01": {
      "host": "<IP>",
      "user": "ag-ssh",
      "identityFile": "C:/Users/you/.ssh/ag_deploy_ed25519",
      "hostKeyChecking": "accept-new",
      "serverId": "srv-test01",
      "deployerCommand": "/opt/nodejs/bin/node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json"
    }
  }
}
```

`deployerCommand` 是**整条远程命令**，由登录 shell 执行——写绝对路径，别指望 PATH。

```powershell
airlock-deploy status --app demo --probe
airlock-deploy release --app demo --source .\dist
```

**验证**：返回里 `activated.health.ok` 是 `true`；再过 5 秒 `status --probe` 服务还在；
服务器上 `readlink /srv/apps/demo/current` 指到新版本。

---

## 7. 回滚演练（别跳过）

```powershell
# 发一个启动即退出的坏版本
airlock-deploy release --app demo --source <坏版本目录> --version v-bad
# 期望：HEALTH_FAILED，自动切回上一版并重启

airlock-deploy rollback --app demo
airlock-deploy status --app demo --probe
```

**验证**：`current` 指回旧版本、服务重新起来、`state.json` 里坏版本是 `failed`。

---

## 8. 收尾检查

- [ ] `airlock-deploy status --app <app>` 返回 `consistent: true`
- [ ] `release` 健康检查通过，5 秒后服务仍在
- [ ] 发坏版本能自动回退，`current` 回到上一版
- [ ] `rollback` 能手动切回
- [ ] `echo whoami | ssh ag-ssh@<IP>` 拿不到 shell（门禁生效）
- [ ] root / 管理员账号仍能进
- [ ] `systemctl stop sshd-rollback.timer` 已执行，`sshd_config.bak-*` 留着
- [ ] 换网络进不去时知道从云控制台加安全组 / 改防火墙
