/**
 * preservePaths：mirror 下「只保护、不改目录结构」。
 *
 * sharedPaths 会把数据搬到 <root>/shared/<路径> 再链回来——目录结构变了。有的项目不能接受：
 * 备份脚本、运维习惯、外部工具都认原路径。这里验证另一条路——发版整棵跳过，
 * 不建链接、不迁移，线上 `data/` 始终是普通目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packProject } from '../src/deploy/archive.ts';
import { createContext } from '../src/deploy/context.ts';
import { activateVersion, installVersion } from '../src/deploy/operations.ts';

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

async function makeApp(t, appConfig = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-preserve-'));
  const root = join(dir, 'site');
  const noop = { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000 };
  const app = {
    root,
    layout: 'mirror',
    runtime: { start: noop, stop: noop },
    health: { command: noop, timeoutMs: 3000, intervalMs: 50 },
    ...appConfig,
  };
  const ctx = createContext({ serverId: 'srv-preserve01', apps: { demo: app } });
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

test('preservePaths：mirror 下发版不覆盖、不删除受保护目录，也不建链接', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t, { preservePaths: ['data'] });
  // 线上数据本来就在服务器上，发布包里不带它
  await publish(ctx, app, dir, 'v1', { 'index.html': 'v1' });
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'media.json'), '后台改过的选择');
  await writeFile(join(root, 'data', 'upload.png'), 'png');

  await publish(ctx, app, dir, 'v2', { 'index.html': 'v2', 'data/media.json': '包里的新值' });

  const info = await lstat(join(root, 'data'));
  assert.equal(info.isDirectory(), true);
  assert.equal(info.isSymbolicLink(), false, 'preservePaths 不能把目录换成链接');
  assert.equal(readFileSync(join(root, 'data', 'media.json'), 'utf8'), '后台改过的选择', '线上数据不能被包里的同名文件覆盖');
  assert.equal(readFileSync(join(root, 'data', 'upload.png'), 'utf8'), 'png', '线上新增的文件不能被 prune 删掉');
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), 'v2', '没被保护的代码照常更新');
  assert.equal(existsSync(join(root, 'shared')), false, 'preservePaths 不制造 shared 目录');
});

test('preservePaths：不配时同场景会被覆盖（确保回归能被抓到）', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'index.html': 'v1', 'data/media.json': 'v1 的选择' });
  await writeFile(join(root, 'data', 'upload.png'), 'png');

  await publish(ctx, app, dir, 'v2', { 'index.html': 'v2', 'data/media.json': '包里的新值' });

  assert.equal(readFileSync(join(root, 'data', 'media.json'), 'utf8'), '包里的新值', '没配保护的目录本来就会被镜像覆盖');
  assert.equal(existsSync(join(root, 'data', 'upload.png')), false, '没配保护的目录本来就会被 prune 清掉');
});

test('preservePaths 与 sharedPaths 共存：前者不建链接，后者仍建', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t, {
    sharedPaths: ['data'],
    preservePaths: ['uploads'],
  });
  await publish(ctx, app, dir, 'v1', { 'index.html': 'v1' });
  // mirror 下 shared 落在 state 目录（root 之外），通过链接写就行
  await writeFile(join(root, 'data', 'leads.json'), '["客户"]');
  await mkdir(join(root, 'uploads'), { recursive: true });
  await writeFile(join(root, 'uploads', 'a.png'), 'png');

  await publish(ctx, app, dir, 'v2', { 'index.html': 'v2', 'uploads/b.png': '包里的图' });

  assert.equal((await lstat(join(root, 'data'))).isSymbolicLink(), true, 'sharedPaths 照旧换成链接');
  assert.equal(readFileSync(join(root, 'data', 'leads.json'), 'utf8'), '["客户"]');
  const uploads = await lstat(join(root, 'uploads'));
  assert.equal(uploads.isSymbolicLink(), false, 'preservePaths 的目录保持普通目录');
  assert.equal(readFileSync(join(root, 'uploads', 'a.png'), 'utf8'), 'png', '线上已有的文件保留');
  assert.equal(existsSync(join(root, 'uploads', 'b.png')), false, '包里的新文件也不写进受保护目录（整棵跳过）');
});

test('preservePaths：嵌套路径的祖先目录不会被 prune 掉', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t, { preservePaths: ['assets/img/uploads'] });
  await publish(ctx, app, dir, 'v1', {
    'index.html': 'v1',
    'assets/site.css': 'v1',
    'assets/img/logo.png': 'logo',
  });
  await mkdir(join(root, 'assets', 'img', 'uploads'), { recursive: true });
  await writeFile(join(root, 'assets', 'img', 'uploads', 'a.png'), 'png');

  await publish(ctx, app, dir, 'v2', {
    'index.html': 'v2',
    'assets/site.css': 'v2',
    'assets/img/uploads/b.png': '包里的图',
  });

  assert.equal(readFileSync(join(root, 'assets', 'img', 'uploads', 'a.png'), 'utf8'), 'png', '受保护的嵌套目录要保留');
  assert.equal(existsSync(join(root, 'assets', 'img', 'uploads', 'b.png')), false);
  assert.equal(readFileSync(join(root, 'assets', 'site.css'), 'utf8'), 'v2', '受保护目录的兄弟目录照常更新');
});
