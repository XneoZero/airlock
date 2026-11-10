#!/usr/bin/env node
/**
 * 服务器侧部署器入口（由 ssh 拉起，或经 sshd ForceCommand）。
 *
 * 只认一个 --config：应用清单、目录、启停命令、健康检查全在服务器本地配置里。
 * **不提供默认路径**——这个进程能切版本、能停服务、能覆盖数据目录，
 * 少配一项就猜一个默认值，等于把「动哪个应用」交给运气。
 *
 * stdout 是协议通道（一行 JSON），任何日志都写 stderr，否则本机会解析到非 JSON 行。
 *
 * 用法：node bin/airlock-deployer.mjs --config /etc/airlock/deployer.json
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { deployerConfigSchema } from '../src/deploy/contracts.ts';
import { createContext } from '../src/deploy/context.ts';
import { StreamReader, parseRequest } from '../src/deploy/protocol.ts';
import { handleRequest } from '../src/deploy/server.ts';

function log(message) {
  process.stderr.write(`[airlock-deployer] ${message}\n`);
}

function die(message, hint) {
  log(`启动失败：${message}`);
  if (hint !== undefined) log(`提示：${hint}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { configPath: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      options.configPath = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      die(`未知参数：${arg}`, '用法：node bin/airlock-deployer.mjs --config <配置文件>');
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write('用法：node bin/airlock-deployer.mjs --config /etc/airlock/deployer.json\n');
  process.exit(0);
}
if (options.configPath === '') die('缺少 --config', '部署器不提供默认配置路径');

let raw;
try {
  raw = JSON.parse(readFileSync(options.configPath, 'utf8'));
} catch (error) {
  const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
  die(`配置不可读：${options.configPath}`, missing ? '确认路径与权限' : '确认是合法 JSON');
}

const parsed = deployerConfigSchema.safeParse(raw);
if (!parsed.success) {
  const issues = parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`);
  die(`配置不符合契约：${issues.join('；')}`, '对照 examples/deployer.example.json 逐项检查');
}

/** 应用根目录按配置文件目录解析：ssh 连上来时 cwd 不一定是部署根。 */
const configDir = dirname(resolve(options.configPath));
const config = {
  ...parsed.data,
  apps: Object.fromEntries(Object.entries(parsed.data.apps).map(([id, app]) => [
    id,
    { ...app, root: isAbsolute(app.root) ? app.root : resolve(configDir, app.root) },
  ])),
};
if (Object.keys(config.apps).length === 0) die('配置里没有任何应用');

const ctx = createContext(config, undefined, resolve(options.configPath));
log(`已连接：${config.serverId}（${ctx.kind}），应用 ${Object.keys(config.apps).join('、')}`);

const reader = new StreamReader(process.stdin);

for (;;) {
  const line = await reader.readLine();
  if (line === null) break;
  const text = line.trim();
  if (text === '') continue;

  let request;
  try {
    request = parseRequest(text);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      v: 1, id: 0, ok: false,
      error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message.slice(0, 300) : '请求不合法' },
    })}\n`);
    continue;
  }

  const response = await handleRequest(ctx, request, reader);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  // install 失败时归档字节可能还没读完，继续解析会把二进制当命令——
  // 一次连接只跑一个 op，直接收工让本机重试。
  if (request.op === 'install' && response.ok !== true) break;
}

process.exit(0);
