/**
 * flat 布局：桌面上的应用文件夹打开就是网站，不再混着 releases/current/state.json。
 *
 * 实现方式是把 root 本身做成指向当前版本的链接，版本与状态挪到
 * `<root 父目录>/.airlock/<app>/`。回滚能力一点没少——换的只是链接目标。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
  const dir = await mkdtemp(join(tmpdir(), 'airlock-flat-'));
  const root = join(dir, 'qingmang');
  const noop = { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000 };
  const ctx = createContext({
    serverId: 'srv-flat0001',
    apps: {
      demo: {
        root,
        layout: 'flat',
        keepReleases: 3,
        runtime: { start: noop, stop: noop },
        health: { command: noop, timeoutMs: 3000, intervalMs: 50 },
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

test('flat：root 变成站点入口，打开就是 index.html', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': '<h1>青芒</h1>', 'assets/a.css': 'body{}' });

  assert.equal((await lstat(root)).isSymbolicLink(), true, 'root 应该是指向当前版本的链接');
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>青芒</h1>');
  assert.equal(existsSync(join(root, 'assets', 'a.css')), true);
  assert.equal(existsSync(join(root, 'releases')), false, '站点目录里不该出现 releases/');
  assert.equal(existsSync(join(root, 'state.json')), false, '站点目录里不该出现 state.json');
});

test('flat：版本与状态挪到 <父目录>/.airlock/<app>/', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': 'ok' });

  const stateDir = join(dir, '.airlock', 'qingmang');
  assert.equal(existsSync(join(stateDir, 'releases', 'v1', 'index.html')), true);
  assert.equal(existsSync(join(stateDir, 'state.json')), true);
  assert.equal(existsSync(join(stateDir, 'deploy.log')), true);
});

test('flat：发第二版后 root 指向新版本，旧版本留着可回滚', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': 'v1' });
  await publish(ctx, app, dir, 'v2', { 'index.html': 'v2' });

  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), 'v2');
  const stateDir = join(dir, '.airlock', 'qingmang');
  assert.deepEqual((await readdir(join(stateDir, 'releases'))).sort(), ['v1', 'v2']);

  const back = await rollbackVersion(ctx, app, { to: 'v1' });
  assert.equal(back.to, 'v1');
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), 'v1', '回滚就是换链接目标');
});

test('flat：root 已有实体目录时，内容整体迁进状态区而不是被删掉', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  // 模拟「之前是 nested 布局，桌面目录里直接有站点文件」
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), 'old-site');
  await writeFile(join(root, 'assets', 'a.css'), 'old');

  await publish(ctx, app, dir, 'v1', { 'index.html': 'new-site' });

  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), 'new-site', '站点已切到新版本');
  const legacy = (await readdir(join(dir, '.airlock', 'qingmang', 'releases'))).filter(name => name.startsWith('legacy-'));
  assert.equal(legacy.length, 1, '老内容应该被挪进 legacy-* 目录保留');
  assert.equal(
    readFileSync(join(dir, '.airlock', 'qingmang', 'releases', legacy[0], 'assets', 'a.css'), 'utf8'),
    'old',
  );
});
