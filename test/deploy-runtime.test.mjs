import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, startApp, waitHealthy } from '../src/deploy/runtime.ts';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('runCommand 返回退出码与输出', async (t) => {
  const root = await tempDir(t);
  const result = await runCommand({
    root,
    command: { command: process.execPath, args: ['-e', 'console.log("hello")'], cwd: 'root' },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello/);
});

test('runCommand 捕获非 0 退出与 stderr', async (t) => {
  const root = await tempDir(t);
  const result = await runCommand({
    root,
    command: { command: process.execPath, args: ['-e', 'console.error("bad"); process.exit(3)'], cwd: 'root' },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /bad/);
});

test('runCommand 超时会杀掉进程', async (t) => {
  const root = await tempDir(t);
  const result = await runCommand({
    root,
    command: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: 'root', timeoutMs: 300 },
  });
  assert.equal(result.timedOut, true);
});

test('Windows 上可执行文件路径用正斜杠也能运行（cmd.exe 的坑）', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await tempDir(t);
  const forwardSlash = process.execPath.replace(/\\/g, '/');
  assert.ok(forwardSlash.includes('/'));
  const result = await runCommand({
    root,
    command: { command: forwardSlash, args: ['-e', 'console.log("slash-ok")'], cwd: 'root' },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /slash-ok/);
});

test('startApp 把退出码转成可读原因', async (t) => {
  const root = await tempDir(t);
  const ok = await startApp(root, { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: 'root' });
  assert.equal(ok.ok, true);
  const bad = await startApp(root, { command: process.execPath, args: ['-e', 'process.exit(2)'], cwd: 'root' });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /退出码 2/);
});

test('健康检查：URL 通过 / 失败 / 未配置', async (t) => {
  const root = await tempDir(t);
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 503);
    response.end('x');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const ok = await waitHealthy(root, { url: `http://127.0.0.1:${port}/health`, expectStatus: 200, timeoutMs: 3000, intervalMs: 50 });
  assert.equal(ok.ok, true);

  const bad = await waitHealthy(root, { url: `http://127.0.0.1:${port}/nope`, expectStatus: 200, timeoutMs: 400, intervalMs: 50 });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /503/);

  const none = await waitHealthy(root, undefined);
  assert.equal(none.ok, true);
});

test('健康检查命令探针按退出码判断', async (t) => {
  const root = await tempDir(t);
  const pass = await waitHealthy(root, {
    command: { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: 'root' },
    timeoutMs: 2000, intervalMs: 50,
  });
  assert.equal(pass.ok, true);

  const fail = await waitHealthy(root, {
    command: { command: process.execPath, args: ['-e', 'process.exit(1)'], cwd: 'root' },
    timeoutMs: 300, intervalMs: 50,
  });
  assert.equal(fail.ok, false);
});
