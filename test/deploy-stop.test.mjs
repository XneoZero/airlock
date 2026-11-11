/**
 * 「stop 没生效」要当场失败，不能让健康检查把旧进程的 200 当成新版本就绪。
 *
 * 真实事故：改落点后新目录没有 app.pid，stop 脚本读不到 pid 直接退出，
 * 旧进程还占着 18080；新版本其实没起来，health 照样 200，发布被判成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packProject } from '../src/deploy/archive.ts';
import { createContext } from '../src/deploy/context.ts';
import { activateVersion, installVersion } from '../src/deploy/operations.ts';
import { waitPortReleased } from '../src/deploy/runtime.ts';

function listen() {
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy());
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('waitPortReleased：端口还开着 → 明确失败', async (t) => {
  const { server, port } = await listen();
  t.after(() => close(server));
  const outcome = await waitPortReleased({ url: `http://127.0.0.1:${port}/health` }, 600);
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, new RegExp(`端口 ${port}`));
});

test('waitPortReleased：端口已释放 → 通过', async () => {
  const { server, port } = await listen();
  await close(server);
  const outcome = await waitPortReleased({ url: `http://127.0.0.1:${port}/health` }, 600);
  assert.equal(outcome.ok, true);
});

test('waitPortReleased：外部地址、没配 url、URL 不合法都不检查', async () => {
  assert.equal(await waitPortReleased({ url: 'http://example.com/health' }, 200), null);
  assert.equal(await waitPortReleased(undefined, 200), null);
  assert.equal(await waitPortReleased({ url: 'not a url' }, 200), null);
});

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

test('activate：旧进程没停、端口仍被占 → STOP_FAILED，current 不动', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-stop-'));
  const root = join(dir, 'app');
  await mkdir(root, { recursive: true });
  const { server, port } = await listen();
  t.after(async () => {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  });

  const noop = { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000 };
  const ctx = createContext({
    serverId: 'srv-stop0001',
    apps: {
      demo: {
        root,
        keepReleases: 3,
        // stop 与 start 都是「什么都不做」：模拟 pid 文件丢了、杀错进程的情况
        runtime: { start: noop, stop: noop },
        health: { url: `http://127.0.0.1:${port}/health`, expectStatus: 200, timeoutMs: 500, intervalMs: 100 },
      },
    },
  });
  const app = ctx.config.apps.demo;

  const source = join(dir, 'src');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'server.mjs'), 'console.log("ok");\n');
  const archive = join(dir, 'v1.tar.gz');
  const manifest = await packProject({ sourceDir: source, outFile: archive });
  await installVersion(ctx, app, {
    version: 'v1',
    archiveSize: (await stat(archive)).size,
    manifestHash: manifest.totalHash,
  }, receiverFor(archive));

  await assert.rejects(
    () => activateVersion(ctx, app, { version: 'v1' }),
    error => {
      assert.equal(error.code, 'STOP_FAILED');
      assert.match(error.message, /仍在监听/);
      return true;
    },
  );

  assert.equal(existsSync(join(root, 'current')), false, '没停下来就不该切 current');
});
