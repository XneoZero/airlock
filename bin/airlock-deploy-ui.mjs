#!/usr/bin/env node
/**
 * 本地 Web 控制台入口。
 *
 * 只绑 127.0.0.1，启动时生成一次性 token 放进 URL——别的网页就算猜到端口，
 * 没有 token 也发不了版。发布/回退复用与 CLI 完全相同的客户端，没有第二套逻辑。
 *
 * 用法：node bin/airlock-deploy-ui.mjs --app demo [--port 7788] [--profile 名] [--profiles 文件] [--no-open]
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { loadProfileTable } from '../src/deploy/local.ts';
import { startUiServer } from '../src/deploy/ui/server.ts';

function fail(message, hint) {
  process.stderr.write(`[airlock-ui] ${message}\n`);
  if (hint !== undefined) process.stderr.write(`[airlock-ui] 提示：${hint}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { profile: process.env.AIRLOCK_DEPLOY_PROFILE ?? '', app: '', port: 7788, open: true, token: process.env.AIRLOCK_UI_TOKEN ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-open') { options.open = false; continue; }
    if (arg === '--app' || arg === '--profile' || arg === '--profiles' || arg === '--port' || arg === '--token') {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} 需要一个值`);
      if (arg === '--app') options.app = value;
      else if (arg === '--profile') options.profile = value;
      else if (arg === '--profiles') options.profiles = value;
      else if (arg === '--token') options.token = value;
      else options.port = Number(value);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法：node bin/airlock-deploy-ui.mjs --app <应用名> [--port 7788] [--token 固定值] [--profile 名] [--profiles 文件] [--no-open]\n');
      process.exit(0);
    }
    fail(`未知参数：${arg}`, '用 --help 查看用法');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

let table;
try {
  table = loadProfileTable(options.profiles);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), '先配好档案，或用 --profiles 指定');
}

// 每个档案 = 一个可在控制台切换的项目。app 取档案里的 app，其次 --app 兜底。
const projects = [];
const skipped = [];
for (const [name, profile] of Object.entries(table.table.profiles)) {
  const app = profile.app ?? (options.app === '' ? undefined : options.app);
  if (app === undefined) {
    skipped.push(name);
    continue;
  }
  projects.push({
    name,
    app,
    workspace: resolve(table.baseDir, profile.workspace ?? '.'),
    profile,
  });
}
if (skipped.length > 0) {
  process.stderr.write(`[airlock-ui] 跳过没有 app 的档案：${skipped.join(', ')}（在档案里写 "app": "web" 或用 --app 指定）\n`);
}
if (projects.length === 0) {
  fail('没有可用的项目', '在档案里给每个项目写 "app": "<应用id>"，或用 --app 指定一个');
}

const defaultProject = options.profile !== '' && projects.some(item => item.name === options.profile)
  ? options.profile
  : (table.table.default !== undefined && projects.some(item => item.name === table.table.default)
    ? table.table.default
    : projects[0].name);

// 控制台要能「添加项目」，所以需要知道档案文件在哪、拿谁做连接模板。
const profileFile = existsSync(table.source) ? table.source : undefined;
const template = projects.find(item => item.name === defaultProject) ?? projects[0];
const baseProfile = template === undefined ? undefined : (() => {
  const copy = { ...template.profile };
  delete copy.app;
  delete copy.workspace;
  return copy;
})();
if (profileFile === undefined) {
  process.stderr.write('[airlock-ui] 档案来自环境变量，控制台的「添加项目」会不可用（无法写回）\n');
}

// 默认每次随机，避免端口被别的页面猜到；要书签就传 --token 或 AIRLOCK_UI_TOKEN。
const token = options.token !== '' ? options.token : randomBytes(18).toString('hex');

let ui;
try {
  ui = await startUiServer({
    projects,
    defaultProject,
    token,
    port: options.port,
    ...(profileFile === undefined ? {} : { profileFile }),
    ...(baseProfile === undefined ? {} : { baseProfile }),
  });
} catch (error) {
  fail(`启动失败：${error instanceof Error ? error.message : String(error)}`, '换个 --port 试试');
}

process.stdout.write(`控制台已启动：${ui.url}\n`);
process.stdout.write(`项目 ${projects.map(item => `${item.name}(${item.app})`).join('、')} · 默认 ${defaultProject}\n`);
process.stdout.write('按 Ctrl+C 停止。\n');

if (options.open) {
  const platform = process.platform;
  try {
    if (platform === 'win32') spawn('cmd', ['/c', 'start', '', ui.url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    else if (platform === 'darwin') spawn('open', [ui.url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [ui.url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    process.stderr.write('[airlock-ui] 自动打开浏览器失败，请手动访问上面的地址\n');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void ui.close().finally(() => process.exit(0));
  });
}
