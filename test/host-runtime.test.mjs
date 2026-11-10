/**
 * 宿主运行时：只测「注入 runner 后如何解读证据」，不启动任何真实服务。
 * 重点是把「探测失败」与「明确停止」分开：前者必须是 running=null / unknown，后者才是 false。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRuntime } from '../src/transports/host-runtime/index.ts';
import { createSystemdRuntime } from '../src/transports/host-runtime/systemd.ts';
import { createWindowsRuntime } from '../src/transports/host-runtime/windows.ts';

/** 记录每次命令的假 runner；`respond` 决定返回什么，可抛错模拟命令不存在。 */
function fakeRunner(respond) {
  const calls = [];
  const runner = async (file, args, timeoutMs) => {
    calls.push({ file, args: [...args], timeoutMs });
    return respond(file, args);
  };
  return { calls, runner };
}

const ok = (stdout) => ({ stdout, stderr: '', code: 0 });

test('systemd：观测 active、入口 up/off，动作重启后有回读', async () => {
  const { calls, runner } = fakeRunner((file, args) => {
    if (file === 'systemctl' && args[0] === 'is-active') return ok('active\n');
    if (file === 'systemctl') return ok('');
    if (file === 'tailscale' && args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running' }));
    return ok(''); // tailscale serve status 空输出 = 未开 serve
  });
  const runtime = createSystemdRuntime({ kind: 'systemd', services: { app: 'airlock-app.service' }, runner });
  const diagnostics = await runtime.diagnose();
  assert.equal(diagnostics.kind, 'systemd');
  assert.equal(diagnostics.entry.tailscale, 'up');
  assert.equal(diagnostics.entry.serve, 'off');
  const core = diagnostics.services.find(service => service.id === 'app');
  assert.equal(core.known, true);
  assert.equal(core.running, true);
  const napcat = diagnostics.services.find(service => service.id === 'worker');
  assert.equal(napcat.known, false);
  assert.equal(napcat.running, null);

  const result = await runtime.action({ service: 'app', action: 'restart' });
  assert.equal(result.accepted, true);
  // --no-block 之后 systemctl 可能已经随 cgroup 被杀：只能报「已排队」，不能报观测结果。
  assert.equal(result.basis, 'request-only');
  assert.match(result.detail, /已排队/);
  assert.ok(calls.some(call => call.args[0] === '--no-block' && call.args[1] === 'restart' && call.args[2] === 'airlock-app.service'));
});

test('systemd：未预注册服务与非法配置都不猜', async () => {
  const { runner } = fakeRunner(() => ok('active\n'));
  const runtime = createSystemdRuntime({ kind: 'systemd', services: { app: 'airlock-app.service' }, runner });
  const result = await runtime.action({ service: 'worker', action: 'restart' });
  assert.equal(result.accepted, false);
  assert.equal(result.basis, 'request-only');
  assert.match(result.detail, /未预注册/);

  assert.throws(
    () => createSystemdRuntime({ kind: 'systemd', services: { app: 'core.service; rm -rf /' }, runner: async () => ok('') }),
    /单元名不合法/,
  );
});

test('systemd：探测失败是 unknown 而不是 stopped', async () => {
  const { runner } = fakeRunner((file) => {
    if (file === 'systemctl') throw new Error('systemctl not found');
    throw new Error('tailscale not found');
  });
  const runtime = createSystemdRuntime({ kind: 'systemd', services: { app: 'airlock-app.service' }, runner });
  const diagnostics = await runtime.diagnose();
  const core = diagnostics.services.find(service => service.id === 'app');
  assert.equal(core.running, null);
  assert.match(core.detail, /无法读取/);
  assert.equal(diagnostics.entry.tailscale, 'unknown');
  assert.equal(diagnostics.entry.serve, 'unknown');
});

test('none：全 known=false / running=null，动作明确拒绝冒充成功', async () => {
  const runtime = createHostRuntime({ kind: 'systemd', services: {} });
  assert.equal(runtime.kind, 'none');
  const diagnostics = await runtime.diagnose();
  assert.equal(diagnostics.entry, null);
  assert.ok(diagnostics.services.length > 0);
  for (const service of diagnostics.services) {
    assert.equal(service.known, false);
    assert.equal(service.running, null);
  }
  const result = await runtime.action({ service: 'app', action: 'restart' });
  assert.equal(result.accepted, false);
  assert.match(result.detail, /动作未预注册/);
});

test('windows：Get-Service 解析、派生独立重启进程、非法服务名被拒', async () => {
  const { calls, runner } = fakeRunner((file) => {
    assert.equal(file, 'powershell.exe');
    return ok('{"status":"Running"}');
  });
  const runtime = createWindowsRuntime({ kind: 'windows-service', services: { app: 'AirlockApp' }, runner });
  const diagnostics = await runtime.diagnose();
  const core = diagnostics.services.find(service => service.id === 'app');
  assert.equal(core.running, true);
  assert.ok(calls.some(call => /Get-Service -Name 'AirlockApp'/.test(call.args.at(-1))));

  const restart = await runtime.action({ service: 'app', action: 'restart' });
  assert.equal(restart.accepted, true);
  assert.equal(restart.basis, 'request-only');
  assert.match(restart.detail, /派生/);
  // 必须交给独立隐藏进程：同步等待的 PowerShell 会随 Core 一起被杀。
  assert.ok(calls.some(call => {
    const script = call.args.at(-1) ?? '';
    return script.includes('Start-Process -WindowStyle Hidden powershell') && script.includes("Restart-Service -Name ''AirlockApp''");
  }));

  assert.throws(
    () => createWindowsRuntime({ kind: 'windows-service', services: { app: "x'; Remove-Item C:\\ -Recurse" }, runner }),
    /服务名不合法/,
  );
});

test('windows：服务不存在时 running=null，不推断为已停止', async () => {
  const runtime = createWindowsRuntime({
    kind: 'windows-service',
    services: { app: 'AirlockApp' },
    runner: async () => ok('null'),
  });
  const diagnostics = await runtime.diagnose();
  const core = diagnostics.services.find(service => service.id === 'app');
  assert.equal(core.running, null);
  assert.match(core.detail, /查不到/);
});
