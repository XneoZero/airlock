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

做法：用**发布通道自己**把代码送上去——deployer 启动的进程是 SYSTEM 身份，能写任何目录。

1. 在本地准备一个"更新器"版本目录：

   ```
   updater\
   ├── server.mjs          启动时覆盖代码，然后起 HTTP 服务让健康检查通过
   └── payload\
       ├── src\            要更新的新代码
       └── bin\
   ```

2. `server.mjs` 的核心逻辑（逐文件覆盖，别用整目录 `cpSync`，容易多套一层）：

   ```js
   function overlay(from, to) {
     mkdirSync(to, { recursive: true });
     for (const entry of readdirSync(from, { withFileTypes: true })) {
       const src = join(from, entry.name), dst = join(to, entry.name);
       if (entry.isDirectory()) overlay(src, dst); else copyFileSync(src, dst);
     }
   }
   overlay(join(here, 'payload', 'src'), 'C:/airlock/src');
   overlay(join(here, 'payload', 'bin'), 'C:/airlock/bin');
   ```

3. `airlock-deploy release --app <app> --source .\updater --version v-update-1`

4. 验证新代码生效：**看日志里有没有只有新版本才会写的那一行**。
   这次是 `端口检查：端口 18080 已释放` 出现在 `deploy.log` 里，说明覆盖成功。

> 这条路也说明了安全模型的事实：**发布通道 = 能在服务器上执行任意代码**。
> `ForceCommand` 挡的是交互 shell，挡不住"发一个版本上来跑"。DEPLOY.md 的
> 「受限账号的权限现实」那节讲的就是这件事。

### 4.3 让服务器自己下载（最省事，前提是镜像通）

服务器能访问镜像时，直接让它拉，不用经过你的机器：

```powershell
# 服务器上
curl.exe -fsS -L -o C:\Windows\Temp\airlock.zip `
  https://ghproxy.net/https://codeload.github.com/XneoZero/airlock/zip/refs/heads/main
```

## 5. 一条命令接入整台 Windows 机器

把上面这些都封在 `scripts/bootstrap-windows.ps1` 里了：

```powershell
.\bootstrap-windows.ps1 -PublicKey 'ssh-ed25519 AAAA... ag-ssh-deploy' -AppId demo
```

它会依次做：下载源码（带镜像重试）→ 装 Node 24 → 解到 `C:\airlock` → `npm ci --omit=dev`
→ 建账号 + 密钥 + sshd 门禁 → 在**管理员桌面**生成落点配置和启停脚本并授权。

先看它要做什么，可以加 `-DryRun`。
