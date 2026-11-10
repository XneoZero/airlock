#!/usr/bin/env node
/**
 * 独立 MCP 服务器入口（服务名 airlock-deploy，stdio）。
 *
 * 与 remote-dev 的 MCP 完全分离：那边是「读改服务器上的文件」，
 * 这边是「把本地构建产物发布上去 / 回滚」。两套能力不能混在一个工具面里，
 * 否则模型在闲聊里也可能拿到「发布到生产」的能力。
 *
 * 用法：AIRLOCK_DEPLOY_PROFILE=prod node bin/airlock-deploy-mcp.mjs [--profile prod]
 */
import { resolve } from 'node:path';
import process from 'node:process';
import { createDeployClient } from '../src/deploy/client.ts';
import { loadProfile } from '../src/deploy/local.ts';
import { createDeployMcpServer } from '../src/deploy/mcp.ts';

function log(message) {
  process.stderr.write(`[airlock-deploy-mcp] ${message}\n`);
}

function die(message, hint) {
  log(`启动失败：${message}`);
  if (hint !== undefined) log(`提示：${hint}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const profileIndex = argv.indexOf('--profile');
const profileName = profileIndex >= 0 ? argv[profileIndex + 1] : (process.env.AIRLOCK_DEPLOY_PROFILE ?? undefined);

let loaded;
try {
  loaded = loadProfile(profileName);
} catch (error) {
  die(error instanceof Error ? error.message : String(error), '先配好 config/deploy-profiles.json，或设置 AIRLOCK_DEPLOY_PROFILES');
}

const sourceDir = resolve(loaded.baseDir, loaded.profile.workspace ?? '.');
const client = createDeployClient({ profile: loaded.profile });
const server = createDeployMcpServer({
  client,
  input: process.stdin,
  output: process.stdout,
  sourceDir,
});

log(`已连接档案=${loaded.name}（${loaded.profile.serverId ?? '未标 serverId'}），工具 ${server.toolNames.length} 个，默认打包目录 ${sourceDir}`);

process.stdin.on('end', () => { server.close(); process.exit(0); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); process.exit(0); });
}
