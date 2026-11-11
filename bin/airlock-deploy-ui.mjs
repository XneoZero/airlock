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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { loadProfileTable } from '../src/deploy/local.ts';
import { startUiServer } from '../src/deploy/ui/server.ts';

/**
 * Airlock 自己的安装目录，不是 cwd。
 *
 * 用户可能在别的项目里跑全局命令（`airlock-deploy ui`），这时 cwd 是那个项目，
 * 拿它当「Airlock 装在哪」会写出错误的提示词。本文件永远在包的 bin/ 下，
 * 往上两级就是包根——全局安装、vendor 进项目、直接 node 跑都成立。
 */
const AIRLOCK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, hint) {
  process.stderr.write(`[airlock-ui] ${message}\n`);
  if (hint !== undefined) process.stderr.write(`[airlock-ui] 提示：${hint}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { profile: process.env.AIRLOCK_DEPLOY_PROFILE ?? '', server: '', app: '', port: 7788, open: true, token: process.env.AIRLOCK_UI_TOKEN ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-open') { options.open = false; continue; }
    if (arg === '--app' || arg === '--profile' || arg === '--profiles' || arg === '--port' || arg === '--token' || arg === '--server') {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} 需要一个值`);
      if (arg === '--app') options.app = value;
      else if (arg === '--profile') options.profile = value;
      else if (arg === '--profiles') options.profiles = value;
      else if (arg === '--token') options.token = value;
      else if (arg === '--server') options.server = value;
      else options.port = Number(value);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法：node bin/airlock-deploy-ui.mjs --app <应用名> [--port 7788] [--token 固定值] [--profile 名] [--server 名] [--profiles 文件] [--no-open]\n');
      process.exit(0);
    }
    fail(`未知参数：${arg}`, '用 --help 查看用法');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

let table;
try {
  // 一份档案都没有也要能起来：零配置用户看到的应该是「接入第一台服务器」的引导页，
  // 而不是一个窗口闪一下就没。指定了 --profiles 但文件坏了仍然直接报错。
  table = loadProfileTable(options.profiles, { allowMissing: true });
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
    serverName: table.table.serverOf[name] ?? '',
  });
}
if (skipped.length > 0) {
  process.stderr.write(`[airlock-ui] 跳过没有 app 的档案：${skipped.join(', ')}（在档案里写 "app": "web" 或用 --app 指定）\n`);
}
// 一个项目都没有不是错误：控制台会渲染「接入第一台服务器」的引导页。

const preferredProject = options.profile !== '' ? options.profile : (table.table.default ?? '');
const defaultProject = projects.some(item => item.name === preferredProject)
  ? preferredProject
  : (projects[0]?.name ?? '');

// 控制台要能「添加项目」，所以需要知道档案文件在哪、拿谁做连接模板。
const profileFile = existsSync(table.source) ? table.source : undefined;
const template = projects.find(item => item.name === defaultProject) ?? projects[0];
const baseProfile = template === undefined ? undefined : (() => {
  const copy = { ...template.profile };
  delete copy.app;
  delete copy.workspace;
  return copy;
})();
// 档案来自环境变量时写不回去，「添加项目」只能关掉。零配置（还没有档案）不算这种情况，
// 那时候本来就没什么可写的，别吓人。
const profileFromEnv = table.source === 'AIRLOCK_DEPLOY_PROFILES' || table.source === 'AIRLOCK_DEPLOY_PROFILES_FILE';
if (profileFile === undefined && profileFromEnv) {
  process.stderr.write('[airlock-ui] 档案来自环境变量，控制台的「添加项目」会不可用（无法写回）\n');
}

// 档案是「只读一份」还是「两份合并」，要告诉前端——不然用户看不到项目内那份的项目，
// 会以为项目丢了（典型场景：设了 AIRLOCK_DEPLOY_PROFILES_FILE，项目内 config 就永远不参与）。
const profilesExplicit = Boolean(
  (options.profiles !== undefined && options.profiles !== '')
  || (process.env.AIRLOCK_DEPLOY_PROFILES_FILE ?? '') !== ''
  || (process.env.AIRLOCK_DEPLOY_PROFILES ?? '') !== '',
);

// 默认每次随机，避免端口被别的页面猜到；要书签就传 --token 或 AIRLOCK_UI_TOKEN。
const token = options.token !== '' ? options.token : randomBytes(18).toString('hex');

let ui;
try {
  ui = await startUiServer({
    projects,
    servers: table.table.servers,
    defaultProject,
    defaultServer: options.server,
    token,
    port: options.port,
    airlockRoot: AIRLOCK_ROOT,
    ...(profileFile === undefined ? {} : { profilesFile: profileFile }),
    ...(options.profiles === undefined || options.profiles === '' ? {} : { profilesPath: options.profiles }),
    ...(options.app === '' ? {} : { fallbackApp: options.app }),
    profilesExplicit,
    ...(profileFile === undefined ? {} : { profileFile }),
    ...(baseProfile === undefined ? {} : { baseProfile }),
  });
} catch (error) {
  fail(`启动失败：${error instanceof Error ? error.message : String(error)}`, '换个 --port 试试');
}

process.stdout.write(`控制台已启动：${ui.url}\n`);
if (projects.length === 0) {
  process.stdout.write('还没有可发布的项目：页面里有「接入第一台服务器」的引导（开 SSH → 把提示词交给 agent → 写档案）。\n');
} else {
  process.stdout.write(`项目 ${projects.map(item => `${item.name}(${item.app})`).join('、')} · 默认 ${defaultProject}\n`);
  const serverNames = Object.keys(table.table.servers);
  if (serverNames.length > 0) process.stdout.write(`服务器可选：${serverNames.join('、')}（控制台右上角切换）\n`);
}
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
