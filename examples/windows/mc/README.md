# Minecraft (Fabric) 服务端示例

四个脚本，配合 `deployer.json` 里一个 `mc` 应用使用。

| 文件 | deployer.json 里的位置 | cwd |
|---|---|---|
| `start-mc.cmd` | `runtime.start` | `current` |
| `stop-mc.ps1` | `runtime.stop` | `root` |
| `install-mc.cmd` | `install` | 版本目录（默认） |
| `mc-launch.cmd` | 只被 `start-mc.cmd` 的 schtasks 引用 | 自己 `cd` |
| `health-mc.ps1` | `health.command` | `root` |

## 关键点

**世界是状态，不是代码。** 发布新版本会解出一个干净目录，如果 `world/` 在里面，
一发布就把存档清空了。所以 `world/` 放在 `root\shared\world`（真实数据），
版本目录里的 `world` 只是指向它的 junction，由 `install-mc.cmd` 每次新建。

`server.properties` 同理：`shared\` 里存一份，install 时复制进版本目录，
这样改配置不会被下一次发布重置。`backupPaths: ["shared"]` 让发布前的数据快照
也覆盖到它们。

**为什么要绕 schtasks。** ssh 一断开，sshd 会回收它的子进程，直接 `java -jar` 起
的服会被一起杀掉。交给任务计划程序（`/ru SYSTEM`）就没有这个问题。

**停止不是优雅的。** 见 `stop-mc.ps1` 里的注释：无窗口会话下 `WM_CLOSE` 送不到，
只能强杀，最后几秒的区块写入可能丢。要真优雅就开 RCON 发 `stop`。

**内存。** `-Xmx` 要比机器总内存留足余量（系统、其它服务都要占）。4G 的机器给
1.5G 堆是稳的上限，别照抄成大值。

## deployer.json 片段

```json
"mc": {
  "root": "C:\\airlock\\apps\\mc",
  "keepReleases": 3,
  "runtime": {
    "start": {
      "command": "C:\\Windows\\System32\\cmd.exe",
      "args": ["/c", "C:\\airlock\\bin\\start-mc.cmd"],
      "cwd": "current",
      "timeoutMs": 30000
    },
    "stop": {
      "command": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\airlock\\bin\\stop-mc.ps1"],
      "cwd": "root",
      "timeoutMs": 30000
    }
  },
  "install": {
    "command": "C:\\Windows\\System32\\cmd.exe",
    "args": ["/c", "C:\\airlock\\bin\\install-mc.cmd"],
    "timeoutMs": 60000
  },
  "health": {
    "command": {
      "command": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\airlock\\bin\\health-mc.ps1"],
      "cwd": "root",
      "timeoutMs": 15000
    },
    "timeoutMs": 300000,
    "intervalMs": 2000
  },
  "backupPaths": ["shared"],
  "keepBackups": 3,
  "restoreBackupOnRollback": true
}
```

`health.timeoutMs` 给 300000 是因为**第一次**启动要生成世界，可能一两分钟；
之后通常几秒就绪。