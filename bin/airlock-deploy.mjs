#!/usr/bin/env node
/**
 * 本机发布 CLI：把本地构建好的目录推到服务器，并按需回滚。
 *
 * 三条纪律：
 * 1. 只发布已经存在的目录，不替用户跑构建命令——构建属于用户自己的流程。
 * 2. 每次发布都打印版本号、内容摘要和服务器返回的真实结果（不打印「应该是成功了吧」）。
 * 3. 失败一律非 0 退出并给出可行动提示，不静默重试。
 *
 * 用法：node bin/airlock-deploy.mjs <命令> [--app 名字] [--profile 档案] [参数]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createDeployClient } from '../src/deploy/client.ts';
import { loadProfile, packRelease } from '../src/deploy/local.ts';
import { installProjectSkill, renderProjectSkill } from '../src/deploy/skill.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const USAGE = `用法：node bin/airlock-deploy.mjs <命令> [--app 名字] [--profile 档案] [--server 名字] [参数]
命令：
  status   [--app 名字] [--probe]        服务器上各应用的当前版本、历史与健康
  list     --app 名字                    版本列表（含未激活的）
  release  --app 名字 [--source 目录] [--version 版本] [--exclude a,b] [--commit sha]
  rollback --app 名字 [--to 版本] [--restore-backup]
  logs     --app 名字 [--lines 50]
  ui       --app 名字 [--port 7788] [--no-open]   本地 Web 控制台
  skill    install [--dir 项目目录] [--force]     在本项目落地一份规范（agent 能直接读到）
  mcp                                    给 MCP 客户端的 stdio 服务器
档案：--profile 名字 / AIRLOCK_DEPLOY_PROFILE
      表：--profiles <文件> / AIRLOCK_DEPLOY_PROFILES_FILE（全局放一份，所有项目共用）
          / AIRLOCK_DEPLOY_PROFILES（内联 JSON）/ config/deploy-profiles.json（当前目录）
服务器：--server 名字（档案 servers 段里的键）。只换机器，app 与本地目录不变。
        不传就用该 profile 自己写的那台。`;

function fail(message, hint) {
  process.stderr.write(`[deploy] ${message}\n`);
  if (hint !== undefined) process.stderr.write(`[deploy] 提示：${hint}\n`);
  process.exit(1);
}

const takesValue = new Set(['--app', '--profile', '--profiles', '--server', '--source', '--version', '--exclude', '--commit', '--to', '--lines', '--timeout', '--dir']);

function parseArgs(argv) {
  const options = { profile: process.env.AIRLOCK_DEPLOY_PROFILE ?? '', timeoutMs: undefined, probe: false, restoreBackup: false, force: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--probe') { options.probe = true; continue; }
    if (arg === '--restore-backup') { options.restoreBackup = true; continue; }
    if (arg === '--force') { options.force = true; continue; }
    if (takesValue.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} 需要一个值`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) fail(`未知参数：${arg}`, '用 --help 查看用法');
    positional.push(arg);
  }
  return { options, positional };
}

const { options, positional } = parseArgs(process.argv.slice(2));
const command = positional[0];
if (options.help === true || command === undefined) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(options.help === true ? 0 : 1);
}

if (command === 'mcp') {
  const child = spawn(process.execPath, [join(SCRIPT_DIR, 'airlock-deploy-mcp.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, ...(options.profile === '' ? {} : { AIRLOCK_DEPLOY_PROFILE: options.profile }) },
  });
  child.on('exit', code => process.exit(code ?? 0));
} else if (command === 'skill') {
  // 规范落在项目的 .dsh/skills/ 下：airlock 自带的 SKILL.md 在 node_modules 里，
  // agent 的 skill 扫描路径看不到它——「随包分发」不等于「能读到」。
  if (positional[1] !== 'install') fail('用法：airlock-deploy skill install [--dir 项目目录] [--force]');
  const projectDir = resolve(options.dir ?? process.cwd());
  const packageRoot = resolve(SCRIPT_DIR, '..');
  const generic = readFileSync(join(packageRoot, 'skills', 'airlock-deploy', 'SKILL.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const facts = { version: pkg.version };
  try {
    const loaded = loadProfile(
      options.profile === '' ? undefined : options.profile,
      options.profiles,
      options.server,
    );
    facts.profile = loaded.name;
    facts.app = options.app ?? loaded.profile.app;
    facts.server = options.server ?? loaded.profile.serverId ?? loaded.profile.host;
    facts.workspace = loaded.profile.workspace ?? loaded.baseDir;
    const client = createDeployClient({ profile: loaded.profile });
    const status = await client.call({
      op: 'status',
      ...(facts.app === undefined ? {} : { app: facts.app }),
    });
    const one = Array.isArray(status?.apps)
      ? status.apps.find(item => item.app === facts.app) ?? status.apps[0]
      : status;
    if (one !== null && typeof one === 'object') {
      facts.app = facts.app ?? one.app;
      facts.root = one.root;
      facts.layout = one.layout ?? null;
      facts.sharedPaths = one.sharedPaths ?? [];
      facts.preservePaths = one.preservePaths ?? [];
    }
  } catch (error) {
    // 连不上服务器也照写：规范里的通道纪律与失败模式本机就能用，缺的只是落点那几行。
    facts.note = error instanceof Error ? error.message : String(error);
  }
  const installed = await installProjectSkill({
    projectDir,
    content: renderProjectSkill(generic, facts),
    force: options.force === true,
  });
  process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`);
  if (installed.status === 'refused') {
    process.stderr.write('[deploy] 该项目已有不是本命令生成的 SKILL.md，未覆盖；确认要覆盖就加 --force\n');
    process.exitCode = 1;
  }
} else if (command === 'ui') {
  // 控制台单独起进程：它要常驻并监听端口，和一次性 CLI 的生命周期不同。
  const env = { ...process.env };
  if (options.profile !== '') env.AIRLOCK_DEPLOY_PROFILE = options.profile;
  if (options.profiles !== undefined) env.AIRLOCK_DEPLOY_PROFILES_FILE = options.profiles;
  const forwarded = process.argv.slice(2).filter(item => item !== 'ui');
  const child = spawn(process.execPath, [join(SCRIPT_DIR, 'airlock-deploy-ui.mjs'), ...forwarded], {
    stdio: 'inherit',
    env,
  });
  child.on('exit', code => process.exit(code ?? 0));
} else {
  let loaded;
  try {
    loaded = loadProfile(
      options.profile === '' ? undefined : options.profile,
      options.profiles,
      options.server,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const client = createDeployClient({
    profile: loaded.profile,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: Number(options.timeoutMs) }),
  });

  try {
    let result;
    let releaseProjectDir = process.cwd();
    switch (command) {
      case 'status':
        result = await client.call({
          op: 'status',
          ...(options.app === undefined ? {} : { app: options.app }),
          params: options.probe ? { probe: true } : {},
        });
        break;
      case 'list':
        if (options.app === undefined) fail('list 需要 --app');
        result = await client.call({ op: 'list', app: options.app });
        break;
      case 'logs':
        if (options.app === undefined) fail('logs 需要 --app');
        result = await client.call({
          op: 'logs', app: options.app,
          params: options.lines === undefined ? {} : { lines: Number(options.lines) },
        });
        break;
      case 'rollback':
        if (options.app === undefined) fail('rollback 需要 --app');
        result = await client.call({
          op: 'rollback', app: options.app,
          params: {
            ...(options.to === undefined ? {} : { to: options.to }),
            ...(options.restoreBackup ? { restoreBackup: true } : {}),
          },
          timeoutMs: 10 * 60_000,
        });
        break;
      case 'release': {
        if (options.app === undefined) fail('release 需要 --app');
        // --source 优先；否则用档案里的 workspace（相对档案文件所在目录解析）。
        const sourceDir = options.source === undefined
          ? resolve(loaded.baseDir, loaded.profile.workspace ?? '.')
          : resolve(options.source);
        releaseProjectDir = sourceDir;
        const packed = await packRelease({
          sourceDir,
          ...(options.version === undefined ? {} : { version: options.version }),
          ...(options.commit === undefined ? {} : { commit: options.commit }),
          ...(options.exclude === undefined ? {} : { exclude: options.exclude.split(',').map(item => item.trim()).filter(Boolean) }),
        });
        process.stderr.write(`[deploy] 打包完成：${packed.version}，${packed.manifest.files.length} 个文件 / ${packed.bytes} 字节\n`);
        try {
          const installed = await client.call({
            op: 'install', app: options.app,
            params: { version: packed.version, manifestHash: packed.manifest.totalHash, commit: packed.commit },
            archive: { file: packed.archive, size: packed.bytes },
            timeoutMs: 20 * 60_000,
          });
          process.stderr.write('[deploy] 安装完成，开始激活\n');
          const activated = await client.call({
            op: 'activate', app: options.app,
            params: { version: packed.version },
            timeoutMs: 20 * 60_000,
          });
          result = { version: packed.version, manifestHash: packed.manifest.totalHash, installed, activated };
        } finally {
          await packed.cleanup();
        }
        break;
      }
      default:
        fail(`未知命令：${command}`, '用 --help 查看命令列表');
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // 第一次在某个项目发布时提醒落规范：skill 在包里、项目里没有，agent 读不到。
    if (command === 'release' && !existsSync(join(releaseProjectDir, '.dsh', 'skills', 'airlock-deploy', 'SKILL.md'))) {
      process.stderr.write('[deploy] 本项目还没有落地 airlock 规范：运行 `airlock-deploy skill install` 生成\n');
    }
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[deploy] ${code}：${message}\n`);
    process.exitCode = 1;
  }
}
