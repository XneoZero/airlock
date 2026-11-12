/**
 * sharedPaths：运行时数据要跨版本活下来。
 *
 * 真实场景：青芒日语官网的 data/（客户线索）和 assets/img/uploads（上传的图片视频）
 * 如果跟着 releases/<版本> 走，发一版就全没了。以前只能在 start hook 里手写 junction，
 * 每个应用重写一遍、还容易漏；现在配在 deployer.json 里，激活时统一挂。
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

async function makeApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-shared-'));
  const root = join(dir, 'app');
  await mkdir(root, { recursive: true });
  const noop = { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000 };
  const ctx = createContext({
    serverId: 'srv-shared01',
    apps: {
      demo: {
        root,
        keepReleases: 3,
        runtime: { start: noop, stop: noop },
        health: { command: noop, timeoutMs: 3000, intervalMs: 50 },
        sharedPaths: ['data', 'assets/img'],
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

test('sharedPaths：首个版本里带的数据会被迁进 shared，版本目录换成链接', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'server.mjs': 'ok\n', 'data/customers.json': '["张三"]' });

  const sharedData = join(root, 'shared', 'data');
  assert.equal(existsSync(join(sharedData, 'customers.json')), true, '数据要落在 shared 下');
  assert.equal(readFileSync(join(sharedData, 'customers.json'), 'utf8'), '["张三"]');

  const link = join(root, 'releases', 'v1', 'data');
  assert.equal((await lstat(link)).isSymbolicLink(), true, '版本目录里的 data 应该是指向 shared 的链接');
  assert.equal(readFileSync(join(link, 'customers.json'), 'utf8'), '["张三"]', '通过链接仍然读得到');
});

test('sharedPaths：下一版不打包 data，运行时写入的数据依然在', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'server.mjs': 'ok\n' });

  // 应用在共享目录里写了数据（真实场景就是客户留言、上传的图片）
  await writeFile(join(root, 'shared', 'data', 'leads.json'), '["王五"]');

  await publish(ctx, app, dir, 'v2', { 'server.mjs': 'ok v2\n' });

  const v2Data = join(root, 'releases', 'v2', 'data');
  assert.equal((await lstat(v2Data)).isSymbolicLink(), true);
  assert.equal(readFileSync(join(v2Data, 'leads.json'), 'utf8'), '["王五"]', '换版本后数据没丢');
});

test('sharedPaths：shared 已有内容时，版本包里的同名目录被丢弃而不是覆盖', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'server.mjs': 'ok\n' });
  await writeFile(join(root, 'shared', 'data', 'live.json'), 'live');

  await publish(ctx, app, dir, 'v2', { 'server.mjs': 'ok\n', 'data/stale.json': 'stale' });

  assert.equal(existsSync(join(root, 'shared', 'data', 'live.json')), true, '线上数据不能被版本包顶掉');
  assert.equal(existsSync(join(root, 'shared', 'data', 'stale.json')), false, '版本包里的旧数据不该混进来');
});

test('sharedPaths：嵌套路径（assets/img）也能挂上', async (t) => {
  const { dir, root, ctx, app } = await makeApp(t);
  await publish(ctx, app, dir, 'v1', { 'server.mjs': 'ok\n' });

  const nested = join(root, 'releases', 'v1', 'assets', 'img');
  assert.equal((await lstat(nested)).isSymbolicLink(), true);
  assert.equal((await lstat(join(root, 'shared', 'assets', 'img'))).isDirectory(), true);
});

test('没配 sharedPaths 时不制造任何 shared 目录', async (t) => {
  const { dir, root, ctx } = await makeApp(t);
  const app = { ...ctx.config.apps.demo, sharedPaths: undefined };
  const ctx2 = createContext({
    serverId: 'srv-shared01',
    apps: { demo: { ...app, sharedPaths: undefined } },
  });
  await publish(ctx2, ctx2.config.apps.demo, dir, 'v1', { 'server.mjs': 'ok\n' });
  assert.equal(existsSync(join(root, 'shared')), false);
});
