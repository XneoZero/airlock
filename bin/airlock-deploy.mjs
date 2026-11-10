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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createDeployClient } from '../src/deploy/client.ts';
import { loadProfile, packRelease } from '../src/deploy/local.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const USAGE = `用法：node bin/airlock-deploy.mjs <命令> [--app 名字] [--profile 档案] [参数]
命令：
  status   [--app 名字] [--probe]        服务器上各应用的当前版本、历史与健康
  list     --app 名字                    版本列表（含未激活的）
  release  --app 名字 [--source 目录] [--version 版本] [--exclude a,b] [--commit sha]
  rollback --app 名字 [--to 版本] [--restore-backup]
  logs     --app 名字 [--lines 50]
  ui       --app 名字 [--port 7788] [--no-open]   本地 Web 控制台
  mcp                                    给 MCP 客户端的 stdio 服务器
档案：--profile 名字 / AIRLOCK_DEPLOY_PROFILE
      表：--profiles <文件> / AIRLOCK_DEPLOY_PROFILES_FILE（全局放一份，所有项目共用）
          / AIRLOCK_DEPLOY_PROFILES（内联 JSON）/ config/deploy-profiles.json（当前目录）`;

function fail(message, hint) {
  process.stderr.write(`[deploy] ${message}\n`);
  if (hint !== undefined) process.stderr.write(`[deploy] 提示：${hint}\n`);
  process.exit(1);
}

const takesValue = new Set(['--app', '--profile', '--profiles', '--source', '--version', '--exclude', '--commit', '--to', '--lines', '--timeout']);

function parseArgs(argv) {
  const options = { profile: process.env.AIRLOCK_DEPLOY_PROFILE ?? '', timeoutMs: undefined, probe: false, restoreBackup: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--probe') { options.probe = true; continue; }
    if (arg === '--restore-backup') { options.restoreBackup = true; continue; }
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
    loaded = loadProfile(options.profile === '' ? undefined : options.profile, options.profiles);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const client = createDeployClient({
    profile: loaded.profile,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: Number(options.timeoutMs) }),
  });

  try {
    let result;
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
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[deploy] ${code}：${message}\n`);
    process.exitCode = 1;
  }
}
