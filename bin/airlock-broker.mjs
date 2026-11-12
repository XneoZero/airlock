#!/usr/bin/env node
/**
 * 服务器侧 stdio Broker 入口（供 bin/airlock.mjs / MCP 通过 ssh 拉起）。
 *
 * 只认一个 `--config`：serverId / workspaceId / root / stateDir / releaseInbox / tasks / writable
 * 全部从这份服务器本地配置读。**不提供默认路径**——Broker 能改工作区文件、能跑检查命令，
 * 配置缺一项就猜一个默认值，等于把「改哪个目录」交给运气。
 *
 * stdout 是 JSON Lines 协议通道；启动日志与错误一律写 stderr，否则客户端会解析到非 JSON 行。
 *
 * 用法：node bin/airlock-broker.mjs --config /etc/airlock/broker.json
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { createStdioBroker } from '../src/transports/remote-dev/broker.ts';

function log(message) {
  process.stderr.write(`[airlock-broker] ${message}\n`);
}

function die(message, hint) {
  log(`启动失败：${message}`);
  if (hint !== undefined) log(`提示：${hint}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { configPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      options.configPath = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      die(`未知参数：${arg}`, '用法：node bin/airlock-broker.mjs --config <配置文件>');
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write('用法：node bin/airlock-broker.mjs --config /etc/airlock/broker.json\n');
  process.exit(0);
}
if (options.configPath === '') die('缺少 --config', 'Broker 不提供默认配置路径');

let raw;
try {
  // 剥掉 UTF-8 BOM：Windows 上手工改过的配置文件常带 BOM，JSON.parse 会直接抛错。
  raw = JSON.parse(readFileSync(options.configPath, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
  die(`配置不可读：${options.configPath}`, missing ? '确认路径与权限' : '确认是合法 JSON');
}

/** 相对路径按配置文件所在目录解析：ssh 连上来时 cwd 不一定是预期目录。 */
const configDir = dirname(resolve(options.configPath));
function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(configDir, value);
}

const problems = [];
function needString(source, key, pattern) {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key} 必须是非空字符串`);
    return null;
  }
  if (pattern !== undefined && !pattern.test(value)) {
    problems.push(`${key} 格式不合法：${value}`);
    return null;
  }
  return value;
}

const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
if (config === null) die('配置必须是 JSON 对象');
// profileId 是客户端档案 id（如 prod），不是 serverId（srv-xxxx）；缺了不猜。
const profileId = needString(config, 'profileId', /^[a-z0-9][a-z0-9-]{1,31}$/);
const serverId = needString(config, 'serverId', /^srv-[a-z0-9]{4,32}$/);
const workspaceId = needString(config, 'workspaceId', /^ws-[a-z0-9]{3,32}$/);
const root = needString(config, 'root');
const stateDir = needString(config, 'stateDir');
const releaseInbox = needString(config, 'releaseInbox');
if (typeof config.writable !== 'boolean') problems.push('writable 必须是布尔值（只读工作区也要显式写 false）');
if (config.tasks === null || typeof config.tasks !== 'object' || Array.isArray(config.tasks)) problems.push('tasks 必须是对象（可为空对象）');
else {
  for (const [name, task] of Object.entries(config.tasks)) {
    if (task === null || typeof task !== 'object' || typeof task.command !== 'string' || task.command === '') {
      problems.push(`tasks.${name} 缺少 command`);
    }
  }
}
for (const key of ['maxFileBytes', 'maxListEntries', 'leaseTtlMs']) {
  if (config[key] !== undefined && (typeof config[key] !== 'number' || !Number.isInteger(config[key]) || config[key] <= 0)) {
    problems.push(`${key} 必须是正整数`);
  }
}
if (config.releaseChannel !== undefined && config.releaseChannel !== 'stable' && config.releaseChannel !== 'dev') {
  problems.push('releaseChannel 只能是 stable 或 dev');
}
if (problems.length > 0) die(`配置 ${options.configPath} 不完整：${problems.join('；')}`, '对照工程方案里的 broker 配置字段逐个补齐');

let created;
try {
  created = createStdioBroker({
    profileId,
    serverId,
    workspaceId,
    root: resolvePath(root),
    writable: config.writable,
    stateDir: resolvePath(stateDir),
    releaseInbox: resolvePath(releaseInbox),
    tasks: config.tasks,
    ...(config.maxFileBytes === undefined ? {} : { maxFileBytes: config.maxFileBytes }),
    ...(config.maxListEntries === undefined ? {} : { maxListEntries: config.maxListEntries }),
    ...(config.leaseTtlMs === undefined ? {} : { leaseTtlMs: config.leaseTtlMs }),
    ...(config.releaseChannel === undefined ? {} : { releaseChannel: config.releaseChannel }),
  }, process.stdin, process.stdout);
} catch (error) {
  die(`Broker 初始化失败：${error instanceof Error ? error.message : String(error)}`, '检查 tasks 的任务名（小写字母开头、2..32 位）与每个任务的 command');
}
const { broker, close } = created;

log(`已连接 stdio：${broker.serverId}/${broker.workspaceId}，任务 ${Object.keys(config.tasks).length} 个，writable=${config.writable}`);

process.stdin.on('end', () => { close(); process.exit(0); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { close(); process.exit(0); });
}
