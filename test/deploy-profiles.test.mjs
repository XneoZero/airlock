/**
 * 档案解析：servers 引用 + 老格式兼容。
 *
 * 重点是「不猜」——引用了不存在的服务器、或者压根没写连接信息，都要当场报错，
 * 而不是悄悄退回到某台机器上发布。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyServer, loadProfile, loadProfileTable } from '../src/deploy/local.ts';

async function withTable(table, run) {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-profiles-'));
  const file = join(dir, 'deploy-profiles.json');
  await writeFile(file, JSON.stringify(table, null, 2), 'utf8');
  try {
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const deployer = 'node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json';

test('servers 引用：连接信息从服务器目录展开', async () => {
  await withTable({
    default: 'demo',
    servers: {
      'srv-a': { host: 'a.example', user: 'deploy', port: 2222, deployerCommand: deployer },
      'srv-b': { host: 'b.example', user: 'deploy', deployerCommand: deployer },
    },
    profiles: {
      demo: { server: 'srv-a', app: 'demo', workspace: '/srv/demo' },
      web: { server: 'srv-b', app: 'web', workspace: '/srv/web' },
    },
  }, file => {
    const { table } = loadProfileTable(file);
    assert.equal(table.profiles.demo.host, 'a.example');
    assert.equal(table.profiles.demo.port, 2222);
    assert.equal(table.profiles.demo.app, 'demo');
    assert.equal(table.profiles.web.host, 'b.example');
    assert.equal(table.profiles.web.port, undefined, '没写的端口不该被别的服务器带过来');
    assert.deepEqual(Object.keys(table.servers).sort(), ['srv-a', 'srv-b']);
    assert.equal(table.default, 'demo');
  });
});

test('servers 引用：内联字段覆盖服务器默认值', async () => {
  await withTable({
    servers: { 'srv-a': { host: 'a.example', user: 'deploy', deployerCommand: deployer } },
    profiles: { demo: { server: 'srv-a', user: 'other', app: 'demo' } },
  }, file => {
    const { table } = loadProfileTable(file);
    assert.equal(table.profiles.demo.host, 'a.example', '服务器提供了 host');
    assert.equal(table.profiles.demo.user, 'other', '内联的 user 覆盖服务器的');
  });
});

test('servers 引用：引用不存在的服务器当场报错', async () => {
  await withTable({
    servers: { 'srv-a': { host: 'a.example', deployerCommand: deployer } },
    profiles: { demo: { server: 'srv-typo', app: 'demo' } },
  }, file => {
    assert.throws(() => loadProfileTable(file), /引用了不存在的服务器：srv-typo/);
  });
});

test('老格式：内联 host + deployerCommand 仍然可用', async () => {
  await withTable({
    default: 'demo',
    profiles: {
      demo: { host: 'a.example', user: 'deploy', deployerCommand: deployer, app: 'demo', workspace: '/srv/demo' },
    },
  }, file => {
    const { table } = loadProfileTable(file);
    assert.equal(table.profiles.demo.host, 'a.example');
    assert.deepEqual(table.servers, {}, '老格式没有 servers 段，给个空对象');
  });
});

test('没有连接信息：明确报错，不猜一台服务器出来', async () => {
  await withTable({
    profiles: { demo: { app: 'demo', workspace: '/srv/demo' } },
  }, file => {
    assert.throws(() => loadProfileTable(file), /缺少连接信息/);
  });
});

test('loadProfile：按名字拿到解析后的档案，相对 workspace 按文件所在目录解析', async () => {
  await withTable({
    default: 'demo',
    servers: { 'srv-a': { host: 'a.example', deployerCommand: deployer } },
    profiles: { demo: { server: 'srv-a', app: 'demo', workspace: './site' } },
  }, file => {
    const loaded = loadProfile(undefined, file);
    assert.equal(loaded.name, 'demo');
    assert.equal(loaded.profile.host, 'a.example');
    assert.ok(loaded.profile.workspace.endsWith('site'), '相对 workspace 要变成绝对路径');
    assert.ok(!loaded.profile.workspace.startsWith('.'), '不能用相对路径喂给打包器');
  });
});

test('--server：只换机器，app 与本地目录不变', async () => {
  await withTable({
    default: 'demo',
    servers: {
      'srv-a': { host: 'a.example', user: 'ua', identityFile: 'k1', deployerCommand: deployer },
      'srv-b': { host: 'b.example', user: 'ub', identityFile: 'k2', deployerCommand: deployer },
    },
    profiles: { demo: { server: 'srv-a', app: 'demo', workspace: 'C:/work/demo' } },
  }, file => {
    const base = loadProfile(undefined, file);
    assert.equal(base.profile.host, 'a.example');

    const moved = loadProfile(undefined, file, 'srv-b');
    assert.equal(moved.profile.host, 'b.example', '连到了另一台');
    assert.equal(moved.profile.user, 'ub');
    assert.equal(moved.profile.identityFile, 'k2', '密钥也要换，不能拿 A 机的钥匙开 B 机');
    assert.equal(moved.profile.app, 'demo', 'app 跟项目走');
    assert.equal(moved.profile.workspace, base.profile.workspace, '本地目录不变');
    assert.equal(moved.name, 'demo');
  });
});

test('--server：名字不存在直接报错，不退回默认机器', async () => {
  await withTable({
    default: 'demo',
    servers: { 'srv-a': { host: 'a.example', deployerCommand: deployer } },
    profiles: { demo: { server: 'srv-a', app: 'demo' } },
  }, file => {
    assert.throws(() => loadProfile(undefined, file, 'srv-typo'), /未知服务器：srv-typo/);
  });
});

test('--server：给了空字符串等于不指定', () => {
  const profile = { host: 'a.example', deployerCommand: deployer, app: 'demo' };
  assert.equal(applyServer(profile, { 'srv-a': { host: 'b.example', deployerCommand: deployer } }, ''), profile);
  assert.equal(applyServer(profile, {}, undefined), profile);
});
