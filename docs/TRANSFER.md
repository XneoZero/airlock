# 拿不到 GitHub 时，怎么把东西弄上去

这份是从国内云主机实测出来的，不是推测。前提：**服务器能上网，但 `github.com` / `codeload.github.com`
经常被 reset**（`curl: (56) Recv failure: Connection was reset`），而 `npmmirror.com` 一直是通的。

## 1. 下载源码：直连失败就换镜像

`scripts/bootstrap-windows.ps1` 内置了这条重试链，实测三个镜像都能拿到包：

```
https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main
https://ghproxy.net/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main
https://gh-proxy.com/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main
https://ghfast.top/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main
```

手工下载也一样，换 `-o` 的地址就行：

```powershell
curl.exe -fsS -L --max-time 180 -o C:\Windows\Temp\airlock.zip `
  https://ghproxy.net/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main
```

判断标准：**下载完看文件大小**。被 reset 的失败会留下 0 字节或几 KB 的残包，
`(Get-Item .\airlock.zip).Length` 应该是 200 KB 上下。

## 2. 装 Node：永远走 npmmirror

```powershell
curl.exe -fsS -L -o node.zip "https://npmmirror.com/mirrors/node/$version/node-$version-win-x64.zip"
```

`npm ci` 也要指 registry，否则默认 registry.npmjs.org 在服务器上可能很慢：

```powershell
& C:\nodejs\npm.cmd ci --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
```

## 3. git 推送：git 不读系统代理，要显式给

本机 `Invoke-WebRequest` 能打开 github.com，但 `git push` 报
`Failed to connect to github.com:443` —— 因为 PowerShell 走的是系统代理（`127.0.0.1:7877`），
git 不走。临时给 git 加上即可：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7877'; $env:HTTP_PROXY='http://127.0.0.1:7877'
git push origin main
```

查当前系统代理：`Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select ProxyEnable,ProxyServer`

## 4. 服务器拿不到任何外网时：三种传文件的办法

按可靠性排序，都是实测过的。

### 4.1 RDP 剪贴板：文本可靠，文件不可靠

文本（命令、配置、几百行 JSON）复制粘贴一直很好用。
**文件经常传不过去**：这次 129 KB 的 zip 在 RDP 桌面按 `Ctrl+V` 没有落地，
而同一时刻粘贴命令文本完全正常。所以别把文件传输当默认手段。

### 4.2 发布通道自更新（agent 没有 shell 时的自救）

场景：`ForceCommand` 只允许 deployer，agent 只剩发布通道，但要更新服务器上的 Airlock 代码。

前提：**部署器里要有一个「沙盒应用」**，它的 `start` 会执行版本目录里的 node 入口
（`node server.mjs`，cwd 是版本目录）。这一点必须先确认——2026-11-12 实测过反面案例：
某个应用看着像沙盒，`start` 其实是固定的 `start-<app>.ps1`，发上去的 `server.mjs` 从未被执行，
健康检查一路超时，还会触发自动回退把代码覆盖回去。

做法：用**发布通道自己**把代码送上去——deployer 起的进程是部署账号的身份，能写安装目录。

1. 生成更新器（仓库内）：

   ```powershell
   node scripts/build-updater.mjs --out .\updater
   # 顺便改服务器配置时：--preserve <应用id>:<路径1>,<路径2>
   # 目标目录与端口：--target C:/airlock --port 3080
   # 生成后直接发：--publish <沙盒应用>@<服务器名>
   ```

   产物是 `server.mjs`（覆盖 payload 后起 HTTP 服务）+ `payload/`（`bin/`、`src/`、两个清单），
   并按常见入口名各拷一份（`index.mjs` / `index.js` / `server.js` / `app.js` / `main.js`），
   带 `type: module` 的 `package.json`——不知道沙盒应用的 start 指向哪个文件名时不用改脚本。
   `config/`、`node_modules/` 与服务器本地脚本不在 payload 里，不会被覆盖。

2. 发出去：

   ```powershell
   node bin/airlock-deploy.mjs release --app <沙盒应用> --server <服务器> --source .\updater --version v0.6.1-<时间戳>
   ```

   更新器的执行顺序是：先覆盖代码 → 再改配置（若带 `--preserve`）→ 再起服务让健康检查通过。
   代码没覆盖成功时**不会**改配置：旧 deployer 不认识新字段，会把整份配置拒掉。

3. 验证新代码生效：`status` 返回里出现 `layout` / `sharedPaths` / `preservePaths`
   （v0.6.0 起才有）。健康检查失败时另看更新器写的落地标记：`%TEMP%\airlock-updater.log`、
   用户目录与安装目录各一份——有标记说明 start 执行了，没标记说明 start 没跑 node 入口。

> 这条路也说明了安全模型的事实：**发布通道 = 能在服务器上执行任意代码**。
> `ForceCommand` 挡的是交互 shell，挡不住「发一个版本上来跑」。DEPLOY.md 的
> 「受限账号的权限现实」那节讲的就是这件事。

### 4.3 让服务器自己下载（最省事，前提是镜像通）

服务器能访问镜像时，直接让它拉，不用经过你的机器：

```powershell
# 服务器上
curl.exe -fsS -L -o C:\Windows\Temp\airlock.zip `
  https://ghproxy.net/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main
```

## 5. 传 Airlock 本体：打包 `node_modules` 比在服务器上装依赖更快

服务器网络差的时候，`npm ci` 会卡到让人怀疑人生。实测更快的做法是**在本机把依赖装好一起传**：

```powershell
# 本机：bin + src + node_modules + 两个清单，一个包
tar.exe -czf "$env:TEMP\airlock-core.tgz" -C C:\path\to\Airlock `
    bin src node_modules package.json package-lock.json

# 服务器（已有 SSH 账号时）
scp "$env:TEMP\airlock-core.tgz" ag-ssh@<IP>:C:/airlock/airlock-core.tgz
ssh ag-ssh@<IP> "tar -xzf C:\airlock\airlock-core.tgz -C C:\airlock"
```

- 服务器上完全不需要编译，`node_modules` 直接能用（`bin` 跑的是 `.ts`，靠 Node 内置类型剥离）；
- 生产部署可以只传 `--omit=dev` 装出来的那份；
- **顺序很重要**：得先有能登录的账号才能 scp。首次接入仍然要走
  `bootstrap-windows.ps1`（或手工装 Node），之后更新代码就用这条路。

## 6. 一条命令接入整台 Windows 机器

把上面这些都封在 `scripts/bootstrap-windows.ps1` 里了：

```powershell
.\bootstrap-windows.ps1 -PublicKey 'ssh-ed25519 AAAA... ag-ssh-deploy' -AppId demo
```

它会依次做：下载源码（带镜像重试）→ 装 Node 24 → 解到 `C:\airlock` → `npm ci --omit=dev`
→ 建账号 + 密钥 + sshd 门禁 → 在**管理员桌面**生成落点配置和启停脚本并授权。

先看它要做什么，可以加 `-DryRun`。
