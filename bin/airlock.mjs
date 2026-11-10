#!/usr/bin/env node
/**
 * 远程开发通道 CLI。本机（开发机）→ 服务器 Broker，走 SSH + JSON Lines。
 *
 * 三条纪律：
 * 1. profile 只放连接信息（host/user/port/identityFile 路径/brokerCommand/…），**不放私钥内容**；
 *    脚本会拒绝疑似凭据字段，避免有人把口令粘进配置文件。
 * 2. stdout 只输出命令结果（JSON）；诊断、ssh 的 stderr 一律转发到本进程 stderr。
 * 3. 缺 profile / 缺参数立刻给可行动的提示并非 0 退出，不做「静默用默认值」的兜底。
 *
 * 用法：node bin/airlock.mjs <命令> [--profile 名字] [参数]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createRemoteDevClient } from '../src/transports/remote-dev/client.ts';

const PROFILE_ENV = 'AIRLOCK_PROFILES';
const PROFILE_FILE = 'config/remote-profiles.json';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const USAGE = `用法：node bin/airlock.mjs <命令> [--profile 名字] [参数]
命令：status | list [--path 前缀] | read --path 文件 [--max-bytes 数值] | diff [--stat] [--path 文件]
      apply --path 文件 --expected-hash <hash|none> --operation-id id (--content 文本 | --content-file 文件)
      check --task 任务名 | job-status --job id | job-cancel --job id
      release --requested-by 名字 --checks 检查JSON文件 | mcp
profile：--profile 名字 / AIRLOCK_PROFILE；表在 AIRLOCK_PROFILES 或 ${PROFILE_FILE}
        brokerCommand 例：node bin/airlock-broker.mjs --config <服务器上的 broker 配置文件>`;

function fail(message, hint) {
  process.stderr.write(`[airlock] ${message}\n`);
  if (hint !== undefined) process.stderr.write(`[airlock] 提示：${hint}\n`);
  process.exit(1);
}

function loadProfileTable() {
  const inline = process.env[PROFILE_ENV];
  if (inline !== undefined && inline.trim() !== '') {
    try {
      return { source: PROFILE_ENV, data: JSON.parse(inline) };
    } catch {
      fail(`${PROFILE_ENV} 不是合法 JSON`, '这里应是一段 JSON：{"profiles":{"dev":{...}}}');
    }
  }
  try {
    return { source: PROFILE_FILE, data: JSON.parse(readFileSync(PROFILE_FILE, 'utf8')) };
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { source: PROFILE_FILE, data: null };
    fail(`profile 文件不可读：${PROFILE_FILE}`, '修好 JSON 或改用 AIRLOCK_PROFILES');
  }
}

/** 私钥/口令只应由系统 ssh 代理与密钥文件承载；profile 里出现凭据字段直接拒绝。 */
function assertNoSecrets(name, profile) {
  for (const key of Object.keys(profile)) {
    if (/private.?key|password|passphrase|secret|token/i.test(key)) {
      fail(`profile ${name} 含疑似凭据字段：${key}`, 'profile 只放 host/user/port/identityFile 路径/brokerCommand，密钥交给 ssh 代理或 -i 文件');
    }
  }
}

function createSshTransport(profile) {
  if (typeof profile.brokerCommand !== 'string' || profile.brokerCommand.trim() === '') {
    fail('profile 缺少 brokerCommand', '例如 "node bin/airlock-broker.mjs --config /etc/airlock/broker.json"');
  }
  if (typeof profile.host !== 'string' || profile.host.trim() === '') fail('profile 缺少 host');
  // 主机密钥默认严格校验：首次 auto-accept 等于把「服务器是不是真的」交给网络。
  // accept-new 只在 profile 显式声明时使用，运行手册要求先用可信途径核对指纹。
  const hostKeyChecking = profile.hostKeyChecking === undefined ? 'yes' : profile.hostKeyChecking;
  if (hostKeyChecking !== 'yes' && hostKeyChecking !== 'accept-new') {
    fail(`profile 的 hostKeyChecking 不合法：${String(hostKeyChecking)}`, '只能是 yes 或 accept-new');
  }
  const args = ['-T', '-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${hostKeyChecking}`, '-o', 'ServerAliveInterval=15'];
  if (typeof profile.userKnownHostsFile === 'string' && profile.userKnownHostsFile !== '') {
    args.push('-o', `UserKnownHostsFile="${profile.userKnownHostsFile}"`);
  }
  if (typeof profile.identityFile === 'string' && profile.identityFile !== '') args.push('-i', profile.identityFile);
  if (profile.port !== undefined) args.push('-p', String(profile.port));
  args.push(typeof profile.user === 'string' && profile.user !== '' ? `${profile.user}@${profile.host}` : profile.host, profile.brokerCommand);
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
    // 对端吐出超长无换行内容时丢弃缓冲，避免 CLI 自己撑爆内存。
    if (buffer.length > 1024 * 1024) buffer = '';
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[ssh] ${chunk}`));
  child.on('error', (error) => process.stderr.write(`[airlock] 无法启动 ssh：${error.message}\n`));
  child.on('exit', (code) => { if (code !== 0) process.stderr.write(`[airlock] ssh 退出码 ${code}\n`); });
  return {
    send(line) { if (child.stdin.writable) child.stdin.write(line); },
    onLine(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    close() { try { child.stdin.end(); } catch { /* 已关闭 */ } child.kill(); },
  };
}

function parseArgs(argv) {
  const options = { profile: process.env.AIRLOCK_PROFILE ?? '', timeoutMs: 30000, stat: false };
  const positional = [];
  const takesValue = {
    '--profile': 'profile', '--timeout': 'timeoutMs', '--path': 'path', '--content': 'content',
    '--content-file': 'contentFile', '--expected-hash': 'expectedHash', '--operation-id': 'operationId',
    '--max-bytes': 'maxBytes', '--task': 'task', '--job': 'job', '--requested-by': 'requestedBy', '--checks': 'checks',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--stat') { options.stat = true; continue; }
    const key = takesValue[arg];
    if (key !== undefined) {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} 需要一个值`);
      options[key] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) fail(`未知参数：${arg}`, '用 --help 查看用法');
    positional.push(arg);
  }
  return { options, positional };
}

function readMaybeFile(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail(`${what} 不可读：${path}`);
  }
}

async function runCommand(client, command, options) {
  switch (command) {
    case 'status': return client.status();
    case 'list': return client.list(options.path);
    case 'read': {
      if (options.path === undefined) fail('read 需要 --path');
      const maxBytes = options.maxBytes === undefined ? undefined : Number(options.maxBytes);
      if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes <= 0)) fail('--max-bytes 必须是正整数');
      return client.read(options.path, maxBytes);
    }
    case 'diff': return client.gitDiff({ ...(options.path === undefined ? {} : { path: options.path }), ...(options.stat ? { stat: true } : {}) });
    case 'apply': {
      if (options.path === undefined) fail('apply 需要 --path');
      if (options.expectedHash === undefined) fail('apply 需要 --expected-hash（新建写 none）');
      if (options.operationId === undefined) fail('apply 需要 --operation-id');
      const expectedHash = options.expectedHash === 'none' ? null : options.expectedHash;
      const params = { path: options.path, expectedHash, operationId: options.operationId };
      if (options.contentFile !== undefined) params.content = readMaybeFile(options.contentFile, '--content-file');
      else if (options.content !== undefined) params.content = options.content;
      else fail('apply 需要 --content 或 --content-file');
      return client.apply(params);
    }
    case 'check': {
      if (options.task === undefined) fail('check 需要 --task');
      return client.check(options.task);
    }
    case 'job-status': {
      if (options.job === undefined) fail('job-status 需要 --job');
      return client.jobStatus(options.job);
    }
    case 'job-cancel': {
      if (options.job === undefined) fail('job-cancel 需要 --job');
      return client.jobCancel(options.job);
    }
    case 'release': {
      if (options.requestedBy === undefined) fail('release 需要 --requested-by');
      if (options.checks === undefined) fail('release 需要 --checks（检查记录 JSON 文件）');
      const checks = JSON.parse(readMaybeFile(options.checks, '--checks'));
      return client.releaseRequest({ requestedBy: options.requestedBy, checks });
    }
    default: fail(`未知命令：${command}`, '用 --help 查看命令列表');
  }
}

const { options, positional } = parseArgs(process.argv.slice(2));
const command = positional[0];
if (options.help || command === undefined) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(options.help ? 0 : 1);
}
const table = loadProfileTable().data;
const profiles = table !== null && typeof table === 'object' && table.profiles !== undefined ? table.profiles : table;
const profileName = options.profile !== '' ? options.profile : (table !== null && typeof table === 'object' ? table.default : undefined);
if (profileName === undefined || profileName === '') {
  fail('没有指定 profile', '用 --profile <名字> 或设置 AIRLOCK_PROFILE；profile 表放在 AIRLOCK_PROFILES 或 ' + PROFILE_FILE);
}
const profile = profiles !== null && typeof profiles === 'object' ? profiles[profileName] : undefined;
if (profile === undefined || typeof profile !== 'object') {
  const names = profiles !== null && typeof profiles === 'object' ? Object.keys(profiles).join(', ') : '（空）';
  fail(`找不到 profile：${profileName}`, `已配置：${names}`);
}
assertNoSecrets(profileName, profile);

if (command === 'mcp') {
  // MCP 服务器自建连接：这里只把 profile 名字传过去，stdin/stdout 原样让给它。
  const child = spawn(process.execPath, [join(SCRIPT_DIR, 'airlock-mcp.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, AIRLOCK_PROFILE: profileName },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const client = createRemoteDevClient({
    transport: createSshTransport(profile),
    timeoutMs: options.timeoutMs === undefined ? 30000 : Number(options.timeoutMs),
  });
  try {
    const result = await runCommand(client, command, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    process.stderr.write(`[airlock] ${code}：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}
