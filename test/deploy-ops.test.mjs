import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readdir, readlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packProject } from '../src/deploy/archive.ts';
import { createContext } from '../src/deploy/context.ts';
import { activateVersion, installVersion, rollbackVersion } from '../src/deploy/operations.ts';

function receiverFor(archivePath) {
  const buffer = readFileSync(archivePath);
  let offset = 0;
  return {
    async readBytes(n) {
      const slice = buffer.subarray(offset, offset + n);
      offset += slice.length;
      if (slice.length === 0) throw new Error('归档数据已耗尽');
      return Buffer.from(slice);
    },
  };
}

async function makeApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-ops-'));
  const root = join(dir, 'app');
  await mkdir(root, { recursive: true });
  const config = {
    serverId: 'srv-test0001',
    apps: {
      demo: {
        root,
        keepReleases: 3,
        runtime: { start: { command: process.execPath, args: ['start.mjs'], timeoutMs: 15000 } },
        health: {
          command: { command: process.execPath, args: ['-e', 'process.exit(require("fs").existsSync("server.mjs") ? 0 : 1)'], timeoutMs: 5000 },
          timeoutMs: 4000, intervalMs: 100,
        },
        backupPaths: ['shared/data'],
      },
    },
  };
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root, ctx: createContext(config) };
}

async function buildSource(dir, name, files) {
  const source = join(dir, `src-${name}`);
  await mkdir(source, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(source, path, '..'), { recursive: true });
    await writeFile(join(source, path), content);
  }
  const archive = join(dir, `${name}.tar.gz`);
  const manifest = await packProject({ sourceDir: source, outFile: archive });
  const size = (await stat(archive)).size;
  return { archive, manifest, size };
}

async function install(ctx, app, dir, name, files, overrides = {}) {
  const { archive, manifest, size } = await buildSource(dir, name, files);
  const params = { version: name, archiveSize: size, manifestHash: manifest.totalHash, ...overrides };
  return installVersion(ctx, app, params, receiverFor(archive));
}

const appOfCtx = ctx => ctx.config.apps.demo;

const GOOD = { 'server.mjs': 'console.log("ok");\n', 'start.mjs': 'process.exit(0);\n' };
const BAD = { 'server.mjs': 'console.log("ok");\n', 'start.mjs': 'process.exit(1);\n' };

test('install 落盘并写状态，重复版本被拒', async (t) => {
  const { dir, root, ctx } = await makeApp(t);
  const app = appOfCtx(ctx);

  const result = await install(ctx, app, dir, 'v1', GOOD);
  assert.equal(result.version, 'v1');
  assert.equal(await readdir(join(root, 'releases')).then(items => items.includes('v1')), true);

  await assert.rejects(() => install(ctx, app, dir, 'v1', GOOD), error => error.code === 'VERSION_EXISTS');
  await assert.rejects(
    () => install(ctx, app, dir, 'v2', GOOD, { version: 'bad/name' }),
    error => error.code === 'VERSION_INVALID',
  );
});

test('清单不一致时拒绝且不留残骸', async (t) => {
  const { dir, root, ctx } = await makeApp(t);
  const app = appOfCtx(ctx);
  await assert.rejects(
    () => install(ctx, app, dir, 'v1', GOOD, { manifestHash: 'f'.repeat(64) }),
    error => error.code === 'MANIFEST_MISMATCH',
  );
  const releases = await readdir(join(root, 'releases')).catch(() => []);
  assert.deepEqual(releases.filter(name => name.startsWith('v1')), []);
});

test('activate 切换 current 并把状态标记为 deployed', async (t) => {
  const { dir, root, ctx } = await makeApp(t);
  const app = appOfCtx(ctx);
  await install(ctx, app, dir, 'v1', GOOD);
  const result = await activateVersion(ctx, app, { version: 'v1' });
  assert.equal(result.version, 'v1');
  assert.equal(result.health.ok, true);

  const target = await readlink(join(root, 'current'));
  assert.equal(target.split(/[\\/]/).pop(), 'v1');

  const again = await activateVersion(ctx, app, { version: 'v1' });
  assert.equal(again.replayed, true);
});

test('未安装的版本不能激活', async (t) => {
  const { ctx } = await makeApp(t);
  await assert.rejects(
    () => activateVersion(ctx, appOfCtx(ctx), { version: 'v9' }),
    error => error.code === 'VERSION_NOT_FOUND',
  );
});

test('激活失败自动回退到上一版，并把失败版本标成 failed', async (t) => {
  const { dir, root, ctx } = await makeApp(t);
  const app = appOfCtx(ctx);
  await install(ctx, app, dir, 'v1', GOOD);
  await activateVersion(ctx, app, { version: 'v1' });
  await install(ctx, app, dir, 'v2', BAD);

  await assert.rejects(() => activateVersion(ctx, app, { version: 'v2' }), error => error.code === 'START_FAILED');
  const target = await readlink(join(root, 'current'));
  assert.equal(target.split(/[\\/]/).pop(), 'v1');

  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  assert.equal(state.current, 'v1');
  assert.equal(state.history.find(item => item.version === 'v2').status, 'failed');
});

test('rollback 回到上一个已部署版本', async (t) => {
  const { dir, root, ctx } = await makeApp(t);
  const app = appOfCtx(ctx);
  await install(ctx, app, dir, 'v1', GOOD);
  await activateVersion(ctx, app, { version: 'v1' });
  await install(ctx, app, dir, 'v2', GOOD);
  await activateVersion(ctx, app, { version: 'v2' });

  const result = await rollbackVersion(ctx, app, {});
  assert.equal(result.from, 'v2');
  assert.equal(result.to, 'v1');
  assert.equal((await readlink(join(root, 'current'))).split(/[\\/]/).pop(), 'v1');

  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  assert.equal(state.current, 'v1');
  assert.equal(state.history.find(item => item.version === 'v2').status, 'rolled_back');
});

test('回滚到不存在的版本给出明确错误', async (t) => {
  const { dir, ctx } = await makeApp(t);
  const app = appOfCtx(ctx);
  await install(ctx, app, dir, 'v1', GOOD);
  await activateVersion(ctx, app, { version: 'v1' });
  await assert.rejects(() => rollbackVersion(ctx, app, { to: 'v9' }), error => error.code === 'VERSION_NOT_FOUND');
  await assert.rejects(() => rollbackVersion(ctx, app, {}), error => error.code === 'NO_PREVIOUS_VERSION');
});

test('回滚可连同数据备份一起恢复', async (t) => {
  const { dir, root, ctx } = await makeApp(t);
  const app = appOfCtx(ctx);
  await mkdir(join(root, 'shared', 'data'), { recursive: true });
  await writeFile(join(root, 'shared', 'data', 'state.json'), '{"v":"one"}');

  await install(ctx, app, dir, 'v1', GOOD);
  await activateVersion(ctx, app, { version: 'v1' });
  await install(ctx, app, dir, 'v2', GOOD);
  // 激活 v2 时备份的是「激活之前」的数据，也就是 v1 时期的内容。
  await activateVersion(ctx, app, { version: 'v2' });
  assert.equal((await readdir(join(root, 'backups'))).includes('v2.tar.gz'), true);

  await writeFile(join(root, 'shared', 'data', 'state.json'), '{"v":"broken"}');
  await rollbackVersion(ctx, app, { to: 'v1', restoreBackup: true });
  const content = readFileSync(join(root, 'shared', 'data', 'state.json'), 'utf8');
  assert.equal(content, '{"v":"one"}');
});
