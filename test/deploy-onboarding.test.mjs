/**
 * 从零接入时最容易卡住的两处：档案里的 BOM，和「一份档案都没有」时的启动路径。
 *
 * 这两条都是 Windows 上真实踩过的：PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，
 * 而新用户第一次双击 airlock-ui.cmd 时档案通常还不存在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfileTable } from '../src/deploy/local.ts';
import { buildJoinPrompt } from '../src/deploy/ui/join-prompt.ts';
import { renderWelcomePage } from '../src/deploy/ui/page.ts';

const deployer = 'node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json';

async function withFile(content, run) {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-onboarding-'));
  const file = join(dir, 'deploy-profiles.json');
  await writeFile(file, content, 'utf8');
  try {
    await run(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const table = {
  default: 'demo',
  servers: { 'srv-a': { host: 'a.example', user: 'ag-ssh', deployerCommand: deployer } },
  profiles: { demo: { server: 'srv-a', app: 'demo', workspace: '/srv/demo' } },
};

test('档案带 UTF-8 BOM 也能读（PowerShell 5.1 默认会写 BOM）', async () => {
  await withFile(`\uFEFF${JSON.stringify(table, null, 2)}`, file => {
    const { table: loaded } = loadProfileTable(file);
    assert.equal(loaded.profiles.demo.host, 'a.example');
  });
});

test('档案不存在：说「读不到」，不要把路径问题说成 JSON 问题', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-onboarding-'));
  try {
    assert.throws(() => loadProfileTable(join(dir, 'nope.json')), /档案文件读不到/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('内容不是 JSON：报「不是合法 JSON」，不要把 JSON 问题说成读不到', async () => {
  await withFile('{ "profiles": { /* 注释是不允许的 */ } }', file => {
    assert.throws(() => loadProfileTable(file), /档案文件不是合法 JSON/);
  });
});

test('接入提示词：Windows 目标机要先让人自己 RDP 去开 SSH', () => {
  const prompt = buildJoinPrompt({
    platform: 'windows', airlockRoot: 'C:\\airlock', profilesFile: 'C:/airlock/config/deploy-profiles.json',
    sep: '\\', hostOs: 'Windows',
  });
  assert.match(prompt, /RDP/);
  assert.match(prompt, /Add-WindowsCapability -Online -Name OpenSSH\.Server/);
  assert.match(prompt, /Get-NetFirewallRule -DisplayName 'OpenSSH-Server-In-TCP'/);
  assert.match(prompt, /<目标机器地址>/, '没给地址就留占位符，别猜一个 IP');
});

test('接入提示词：Linux 目标机不写成 Windows 的命令', () => {
  const prompt = buildJoinPrompt({
    platform: 'linux', airlockRoot: '/opt/airlock', profilesFile: '/opt/airlock/config/deploy-profiles.json',
    sep: '/', hostOs: 'Linux',
  });
  assert.match(prompt, /openssh-server/);
  assert.doesNotMatch(prompt, /Add-WindowsCapability/);
});

test('欢迎页：零配置打开控制台不再是空白，而是接入引导', () => {
  const page = renderWelcomePage({
    airlockRoot: 'C:\\airlock',
    profilesFile: 'C:/airlock/config/deploy-profiles.json',
    platform: 'win32',
  });
  assert.match(page, /还没有可发布的项目/);
  assert.match(page, /OpenSSH\.Server/, '第一步得告诉人怎么把 SSH 打开');
  assert.match(page, /RDP/, '这一步只有人能进服务器做');
  assert.match(page, /Add-WindowsCapability/);
  assert.match(page, /PROMPTS = \{/, '提示词要能复制给 agent');
  assert.match(page, /C:\/airlock\/config\/deploy-profiles\.json/, '要写清档案在哪，别让人猜');
});
