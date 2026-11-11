/**
 * 「接入新服务器」提示词：把目标机上要做什么，写成一段能直接交给 agent 的话。
 *
 * 单独放一个文件，是因为两个入口都要用它：有项目时控制台的「＋ 服务器」弹窗，
 * 和零配置时的欢迎页。两处文案必须一模一样，否则用户按哪份做都有一半是过期的。
 */
export interface JoinPromptOptions {
  /** 目标机地址；不填就留占位符，用户自己填。 */
  readonly host?: string;
  readonly platform: 'windows' | 'linux';
  /** 本机 Airlock 安装目录（包根），写进提示词。 */
  readonly airlockRoot: string;
  /** 实际生效的档案文件；档案来自环境变量时为空。 */
  readonly profilesFile?: string;
  /** 运行控制台这台机器的路径分隔符。 */
  readonly sep: string;
  /** 运行控制台这台机器叫什么（Windows / macOS / Linux）。 */
  readonly hostOs: string;
}

/** 用户没填地址时的占位符，前端把它替换成真实 host。 */
export const JOIN_TARGET_PLACEHOLDER = '<目标机器地址>';

export function buildJoinPrompt(options: JoinPromptOptions): string {
  const target = options.host !== undefined && options.host.trim() !== '' ? options.host.trim() : JOIN_TARGET_PLACEHOLDER;
  const os = options.platform === 'linux' ? 'Linux' : 'Windows';
  const profileWhere = (options.profilesFile ?? '') !== ''
    ? (options.profilesFile as string)
    : '档案文件 deploy-profiles.json（可能由 AIRLOCK_DEPLOY_PROFILES_FILE 环境变量指定）';

  const lines = [
    '帮我把一台新机器接成 Airlock 的部署目标。',
    '',
    `【工具】Airlock 装在本机 ${options.airlockRoot}（${options.hostOs}）`,
    `【档案】${profileWhere}`,
    `【目标】${target}（${os}）`,
    '',
    '按顺序做，每一步都要验证结果，不要假设上一步已经生效：',
    '',
  ];

  if (os === 'Windows') {
    lines.push(
      '1. 先测目标机 22 端口，分清是哪一种失败：',
      '   · 连接超时 = 包被丢掉，多半是云安全组或防火墙没放行；',
      '   · 连接被拒绝（RST）= 端口通了但 sshd 没在监听。',
      '   这两种都只有机器主人能解决：3389 能进就现在 RDP 进去，管理员 PowerShell 里跑',
      '     Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
      '     Start-Service sshd; Set-Service sshd -StartupType Automatic',
      "     Get-NetFirewallRule -DisplayName 'OpenSSH-Server-In-TCP' | Set-NetFirewallRule -Enabled True -Profile Any",
      '   22 也不通就先在云控制台放行 22；3389 也进不去就还得放行 3389。',
      '   这一步不要替我做，也不要假设「等会就好了」——测到 22 通为止。',
      '2. 装 Node ≥ 24，记下 node.exe 的绝对路径，后面 deployer 命令要用。',
      '3. 建部署账号（默认 ag-ssh）+ 专用密钥。这一步最容易翻车，三个必查项：',
      `   a. 公钥必须写进「真实的 profile 目录」——Windows 上常常是 C:${options.sep}Users${options.sep}ag-ssh.<机器名>，`,
      `      不是 C:${options.sep}Users${options.sep}ag-ssh。用注册表 ProfileList 查实际目录，别猜。`,
      '   b. sshd_config 里如果有 AllowGroups / AllowUsers，新账号必须在名单里，',
      '      否则密钥再对也会被拒，而日志只会说 publickey denied。',
      '   c. authorized_keys 必须是 ASCII 或 UTF-8 无 BOM，写文件时显式指定编码。',
      '4. 配 sshd 的 Match User + ForceCommand（只允许走部署通道）。',
      '   改之前先挂一个 10 分钟自动回滚的计划任务，改完立刻测一次能登进来再继续。',
      '5. 把 ' + options.airlockRoot + ' 里的 bin/ 和 src/ 拷到目标机，写 config/deployer.json',
      '   （应用 id、root、start/stop、健康检查）。root 用',
      `   C:${options.sep}Users${options.sep}Administrator${options.sep}Desktop${options.sep}<应用id>——Windows 上默认发布在管理员桌面，`,
      `   但部署账号读不到别人的 profile 目录，所以要把 C:${options.sep}Users${options.sep}Administrator${options.sep}Desktop${options.sep}<应用id>`,
      '   用 icacls 授给部署组（(OI)(CI)M），否则第一次发布会卡在建 releases/。',
      '6. 在档案里加一个 servers 条目，然后跑',
      `   node "${options.airlockRoot}${options.sep}bin${options.sep}airlock-deploy.mjs" status --app <应用>`,
      '   确认能连通、能看到 root。',
      '',
      '已知的坑（上次接机器时真遇到过，别重复）：',
      '· Windows 防火墙规则 OpenSSH-Server-In-TCP 可能是 Disabled，而且只覆盖 Private 配置文件。',
      '  表现就是「服务 Running、22 依然不通」。要启用它并覆盖实际使用的配置文件（Domain/Public）。',
      '· 改 authorized_keys 的 ACL 时不要用 /inheritance:r 一刀切，那会把 Administrators 也锁在外面。',
      '  保留 SYSTEM 和 Administrators 的访问权。',
      '· 不要复用日常或 RDP 账号做部署账号：同一账号 SSH 与 RDP 会互踢会话。',
    );
  } else {
    lines.push(
      '1. 先测目标机 22 端口。连接超时要区分是云安全组丢包还是 sshd 没起；',
      '   没起的话需要机器主人自己进控制台/VNC 装 openssh-server 并放行 22，agent 做不到这一步。',
      '   这一步不要替我做了，也不要假设「等会就好了」——测到 22 通为止。',
      '2. 装 Node ≥ 24，记下 node 的绝对路径。',
      '3. 建部署账号（默认 ag-ssh）+ 专用密钥，写进 ~/.ssh/authorized_keys，权限 600、目录 700。',
      '4. 配 sshd 的 Match User + ForceCommand（只允许走部署通道）。',
      '   改之前先挂一个 10 分钟自动回滚的 cron/systemd timer，改完立刻测一次能登进来再继续。',
      '5. 把 ' + options.airlockRoot + ' 里的 bin/ 和 src/ 拷到目标机，写 config/deployer.json',
      '   （应用 id、root、start/stop、健康检查）。root 按目标机的惯例选，别放在会被清理的目录。',
      '6. 在档案里加一个 servers 条目，然后跑',
      `   node "${options.airlockRoot}${options.sep}bin${options.sep}airlock-deploy.mjs" status --app <应用>`,
      '   确认能连通、能看到 root。',
      '',
      '已知的坑：',
      '· 不要复用日常账号做部署账号；SSH 的 ForceCommand 会影响这个账号的所有登录。',
      '· deployer 是裸进程托管时，systemd 的 KillMode 若为 control-group，ssh 断开可能连带收掉子进程。',
    );
  }

  lines.push('', '做完告诉我：服务器名字、应用 id、落点路径、要开哪些端口。');
  return lines.join('\n');
}
