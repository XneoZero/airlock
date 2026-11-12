/**
 * mirror 布局：服务器上就是源目录的副本。
 *
 * 版本由 git 管——回退 = `git checkout` 到旧提交再发一版，服务器不保留 releases/、
 * current、state.json。用户要的正是「服务器上看到和本地文件夹一样的内容和结构」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packProject } from '../src/deploy/archive.ts';
import { createContext } from '../src/deploy/context.ts';
import { activateVersion, installVersion, rollbackVersion } from '../src/deploy/operations.ts';
import { syncMirror } from '../src/deploy/mirror.ts';

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
  const dir = await mkdtemp(join(tmpdir(), 'airlock-mirror-'));
  const root = join(dir, 'qingmang');
  const noop = { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000 };
  const ctx = createContext({
    serverId: 'srv-mirror01',
    apps: {
      demo: {
        root,
        layout: 'mirror',
        runtime: { start: noop, stop: noop },
        health: { command: noop, timeoutMs: 3000, intervalMs: 50 },
        sharedPaths: ['data'],
      },
    },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root, ctx, app: ctx.config.apps.demo };
}

async function publish(ctx, app, dir, version, files) {
  const source = join(dir, `src-${version}`);
  await mkdir(source, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(source, path, '..'), { recursive: true });
    await writeFile(join(source, path), content);
  }
  const archive = join(dir, `${version}.tar.gz`);
  const manifest = await packProject({ sourceDir: source, outFile: archive });
  await installVersion(ctx, app, {
    version,
    archiveSize: (await stat(archive)).size,
    manifestHash: manifest.totalHash,
  }, receiverFor(archive));
  return activateVersion(ctx, app, { version });
}

test('mirror：落点内容与源目录一致，不多出任何管理目录', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': '<h1>站点</h1>', 'assets/a.css': 'body{}' });

  assert.equal((await stat(root)).isDirectory(), true);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>站点</h1>');
  assert.equal(readFileSync(join(root, 'assets', 'a.css'), 'utf8'), 'body{}');
  for (const name of ['releases', 'current', 'state.json', 'deploy.log', 'incoming', 'backups']) {
    assert.equal(existsSync(join(root, name)), false, `落点里不该出现 ${name}`);
  }
});

test('mirror：新版本会删掉上一版多出来的文件（真正的镜像）', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': 'v1', 'old-only.js': 'old' });
  await publish(ctx, app, dir, 'v2', { 'index.html': 'v2', 'new-only.js': 'new' });

  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), 'v2');
  assert.equal(existsSync(join(root, 'old-only.js')), false, '上一版独有的文件应被清掉');
  assert.equal(existsSync(join(root, 'new-only.js')), true);
});

test('mirror：sharedPaths 里的数据不会被镜像删掉', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': 'v1' });

  // 应用往共享数据目录写东西
  await writeFile(join(root, 'data', 'leads.json'), '["客户"]');
  await publish(ctx, app, dir, 'v2', { 'index.html': 'v2' });

  assert.equal(readFileSync(join(root, 'data', 'leads.json'), 'utf8'), '["客户"]', '数据目录必须原样保留');
});

test('mirror：rollback 明确拒绝，提示用 git 回退后重发', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': 'v1' });
  await assert.rejects(
    () => rollbackVersion(ctx, app, {}),
    error => {
      assert.equal(error.code, 'NO_PREVIOUS_VERSION');
      assert.match(error.message, /git checkout/);
      return true;
    },
  );
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), 'v1', '拒绝回滚不能动现有内容');
});

test('syncMirror：只同步、不清 protected 目录', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'src');
  const target = join(dir, 'dst');
  await mkdir(join(source, 'assets'), { recursive: true });
  await mkdir(join(target, 'data'), { recursive: true });
  await writeFile(join(source, 'index.html'), 'new');
  await writeFile(join(source, 'assets', 'a.css'), 'css');
  await writeFile(join(target, 'data', 'keep.json'), 'keep');
  await writeFile(join(target, 'stale.txt'), 'stale');

  const result = syncMirror(source, target, ['data']);
  assert.equal(result.written, 2);
  assert.equal(readFileSync(join(target, 'index.html'), 'utf8'), 'new');
  assert.equal(existsSync(join(target, 'stale.txt')), false);
  assert.equal(readFileSync(join(target, 'data', 'keep.json'), 'utf8'), 'keep');
});
