#!/usr/bin/env node
/**
 * 独立 MCP 服务器入口（服务名 airlock-remote-dev，stdio）。
 *
 * 只做三件事：读 profile → 建 SSH 传输 → 把 10 个远程开发工具挂到 stdio。
 * stdout 是 MCP 协议通道，任何日志都写 stderr，否则客户端会解析到非 JSON 行并断开。
 *
 * 与聊天工具面完全分离：不读主程序配置、不读 agent 令牌、不连控制端。
 *
 * 用法：AIRLOCK_PROFILE=dev node bin/airlock-mcp.mjs [--profile dev]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { createRemoteDevClient } from '../src/transports/remote-dev/client.ts';
import { createRemoteDevMcpServer } from '../src/transports/remote-dev/mcp.ts';

const PROFILE_ENV = 'AIRLOCK_PROFILES';
const PROFILE_FILE = 'config/remote-profiles.json';

function log(message) {
  process.stderr.write(`[airlock-mcp] ${message}\n`);
}

function die(message, hint) {
  log(`启动失败：${message}`);
  if (hint !== undefined) log(hint);
  process.exit(1);
}

function loadProfiles() {
  const inline = process.env[PROFILE_ENV];
  if (inline !== undefined && inline.trim() !== '') {
    try {
      return JSON.parse(inline);
    } catch {
      die(`${PROFILE_ENV} 不是合法 JSON`);
    }
  }
  try {
    return JSON.parse(readFileSync(PROFILE_FILE, 'utf8'));
  } catch (error) {
    const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
    die(`profile 不可用：${missing ? `没有 ${PROFILE_FILE}，也没有设置 ${PROFILE_ENV}` : `${PROFILE_FILE} 不可读或不是 JSON`}`,
      '先在 config/remote-profiles.json 配好 profile，或导出 AIRLOCK_PROFILES');
  }
}

function createSshTransport(profile) {
  // 主机密钥默认严格校验；accept-new 只在 profile 显式声明时使用（运行手册要求先核对指纹）。
  const hostKeyChecking = profile.hostKeyChecking === undefined ? 'yes' : profile.hostKeyChecking;
  if (hostKeyChecking !== 'yes' && hostKeyChecking !== 'accept-new') {
    die(`profile 的 hostKeyChecking 不合法：${String(hostKeyChecking)}`, '只能是 yes 或 accept-new');
  }
  const args = ['-T', '-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${hostKeyChecking}`, '-o', 'ServerAliveInterval=15'];
  if (typeof profile.userKnownHostsFile === 'string' && profile.userKnownHostsFile !== '') {
    args.push('-o', `UserKnownHostsFile="${profile.userKnownHostsFile}"`);
  }
  if (typeof profile.identityFile === 'string' && profile.identityFile !== '') args.push('-i', profile.identityFile);
  if (profile.port !== undefined) args.push('-p', String(profile.port));
  const destination = typeof profile.user === 'string' && profile.user !== '' ? `${profile.user}@${profile.host}` : profile.host;
  args.push(destination, profile.brokerCommand);
  const child = spawn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const handlers = new Set();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') for (const handler of handlers) handler(line);
      index = buffer.indexOf('\n');
    }
    if (buffer.length > 1024 * 1024) buffer = '';
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => log(`ssh: ${chunk.trim()}`));
  child.on('error', (error) => log(`无法启动 ssh：${error.message}`));
  child.on('exit', (code) => { if (code !== 0) log(`ssh 退出码 ${code}`); });
  return {
    send(line) { if (child.stdin.writable) child.stdin.write(line); },
    onLine(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    close() { try { child.stdin.end(); } catch { /* 已关闭 */ } child.kill(); },
  };
}

const argv = process.argv.slice(2);
const profileArgIndex = argv.indexOf('--profile');
const table = loadProfiles();
const profiles = table !== null && typeof table === 'object' && table.profiles !== undefined ? table.profiles : table;
const name = profileArgIndex >= 0 ? argv[profileArgIndex + 1] : (process.env.AIRLOCK_PROFILE ?? (table !== null && typeof table === 'object' ? table.default : undefined));
if (name === undefined || name === '') die('没有指定 profile', '用 --profile <名字> 或设置 AIRLOCK_PROFILE');
const profile = profiles !== null && typeof profiles === 'object' ? profiles[name] : undefined;
if (profile === undefined || typeof profile !== 'object') {
  const names = profiles !== null && typeof profiles === 'object' ? Object.keys(profiles).join(', ') : '（空）';
  die(`找不到 profile：${name}`, `已配置：${names}`);
}
if (typeof profile.brokerCommand !== 'string' || profile.brokerCommand === '') die('profile 缺少 brokerCommand');

const client = createRemoteDevClient({ transport: createSshTransport(profile) });
const server = createRemoteDevMcpServer({ client, input: process.stdin, output: process.stdout });
log(`已连接 profile=${name}（${profile.serverId ?? '未标 serverId'}），工具 ${server.toolNames.length} 个`);

process.stdin.on('end', () => { server.close(); process.exit(0); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); process.exit(0); });
}
