/**
 * 服务器侧两个运维 op：列目录、改落点。
 *
 * 重点是「不猜」：盘根和系统目录一律拒绝，写回要原子且只改 root。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createContext } from '../src/deploy/context.ts';
import { defaultStartDir, listServerDirectory, updateRoot } from '../src/deploy/root.ts';

const baseApp = { runtime: { start: { command: 'cmd', args: ['/c', 'echo ok'] } } };

function contextWith(rootPath, configPath) {
  const config = { serverId: 'srv-test01', kind: 'windows', apps: { demo: { ...baseApp, root: rootPath } } };
  return createContext(config, () => 0, configPath);
}

async function tempConfig(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-root-'));
  const file = join(dir, 'deployer.json');
  await writeFile(file, JSON.stringify(contents, null, 2), 'utf8');
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('默认起点是部署账号的桌面，没有桌面就退回家目录', () => {
  const ctx = contextWith('C:\\airlock\\apps\\demo');
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const start = defaultStartDir(ctx);
  const desktop = join(home, 'Desktop');
  assert.equal(start, existsSync(desktop) ? desktop : home);
  assert.ok(existsSync(start), '默认起点必须是真实存在的目录，不能给个假路径');
});

test('列目录：只回子目录与少量文件，父目录按盘根截断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-ls-'));
  try {
    await mkdir(join(dir, 'dist'));
    await mkdir(join(dir, 'public'));
    await writeFile(join(dir, 'index.html'), '<h1>ok</h1>');
    await writeFile(join(dir, '.hidden'), 'x');

    const ctx = contextWith(dir);
    const listing = listServerDirectory(ctx, dir);
    const names = listing.entries.map(item => item.name);

    assert.deepEqual(names.filter(name => name === 'dist' || name === 'public'), ['dist', 'public']);
    assert.ok(names.includes('index.html'), '文件也要能看见，用来判断是不是构建产物');
    assert.equal(names.includes('.hidden'), false, '隐藏文件不列');
    assert.ok(listing.places.length > 0, '要给出快捷位置');
    assert.equal(listing.truncated, false);
    // 临时目录不是盘根，必须能往上走一层。
    assert.equal(listing.parent, dirname(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('列目录：不存在的目录报错，不猜一个默认值', () => {
  const ctx = contextWith('C:\\airlock\\apps\\demo');
  assert.throws(() => listServerDirectory(ctx, join(tmpdir(), 'airlock-not-exist-' + Date.now())), /目录不存在或不可读/);
});

test('改落点：盘根与系统目录一律拒绝', () => {
  const ctx = contextWith('C:\\airlock\\apps\\demo', 'C:\\airlock\\config\\deployer.json');
  assert.throws(() => updateRoot(ctx, 'demo', 'C:\\'), /不能把盘根当发布目录/);
  assert.throws(() => updateRoot(ctx, 'demo', 'C:\\Windows\\Temp\\x'), /不能发布到系统目录/);
  assert.throws(() => updateRoot(ctx, 'demo', 'C:\\Program Files\\x'), /不能发布到系统目录/);
  assert.throws(() => updateRoot(ctx, 'demo', 'relative\\path'), /必须是绝对路径/);
});

test('改落点：写回配置文件，只动 root，其它字段保留', async () => {
  const seeded = {
    serverId: 'srv-test01',
    kind: 'windows',
    apps: {
      demo: { ...baseApp, root: 'C:\\airlock\\apps\\demo', keepReleases: 5 },
      web: { ...baseApp, root: 'C:\\airlock\\apps\\web' },
    },
  };
  const temp = await tempConfig(seeded);
  try {
    const target = join(temp.dir, 'Desktop', 'demo');
    const ctx = contextWith('C:\\airlock\\apps\\demo', temp.file);
    const result = updateRoot(ctx, 'demo', target);

    assert.equal(result.app, 'demo');
    assert.equal(result.previous, 'C:\\airlock\\apps\\demo');
    assert.equal(result.root, target);

    const written = JSON.parse(await readFile(temp.file, 'utf8'));
    assert.equal(written.apps.demo.root, target);
    assert.equal(written.apps.demo.keepReleases, 5, '其它字段不能被抹掉');
    assert.equal(written.apps.web.root, 'C:\\airlock\\apps\\web', '别的应用不受影响');
    assert.equal(written.serverId, 'srv-test01');
  } finally {
    await temp.cleanup();
  }
});

test('改落点：同一路径返回「没有变化」，不写文件', async () => {
  const temp = await tempConfig({ serverId: 'srv-test01', kind: 'windows', apps: { demo: { ...baseApp, root: 'C:\\airlock\\apps\\demo' } } });
  try {
    const ctx = contextWith('C:\\airlock\\apps\\demo', temp.file);
    const result = updateRoot(ctx, 'demo', 'C:\\airlock\\apps\\demo');
    assert.match(result.note, /没有变化/);
  } finally {
    await temp.cleanup();
  }
});

test('改落点：没拿到配置路径时明确拒绝', () => {
  const ctx = contextWith('C:\\airlock\\apps\\demo');
  assert.throws(() => updateRoot(ctx, 'demo', 'C:\\airlock\\apps\\demo2'), /没有拿到配置路径/);
});

test('改落点：未配置的应用不猜', () => {
  const ctx = contextWith('C:\\airlock\\apps\\demo', 'C:\\airlock\\config\\deployer.json');
  assert.throws(() => updateRoot(ctx, 'nope', 'C:\\airlock\\apps\\nope'), /未配置的应用/);
});
