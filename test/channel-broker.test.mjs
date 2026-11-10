/**
 * Broker：12 个 op 的分权与错误码。全部在临时目录 + 本机 node 进程里跑，
 * 不连服务器、不读 config.json / data。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBroker } from '../src/transports/remote-dev/broker.ts';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'airlock-broker-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let caseNo = 0;
let nextId = 1;

function setup(overrides = {}) {
  const base = path.join(TMP, `case-${(caseNo += 1)}`);
  const root = path.join(base, 'ws');
  mkdirSync(root, { recursive: true });
  const config = {
    profileId: 'prod',
    serverId: 'srv-test01',
    workspaceId: 'ws-dev',
    root,
    writable: true,
    stateDir: path.join(base, 'state'),
    releaseInbox: path.join(base, 'inbox'),
    tasks: {},
    ...overrides,
  };
  return { base, root, config };
}

function send(broker, op, params = {}, leaseId) {
  return broker.dispatch({ v: 1, id: (nextId += 1), op, params, ...(leaseId === undefined ? {} : { leaseId }) });
}

const codeOf = (response) => (response.ok ? null : response.error.code);

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待条件超时');
}

test('status：服务器身份、工作区与任务清单', async () => {
  const { config } = setup({ tasks: { tests: { command: process.execPath, args: ['-e', ''] } } });
  const broker = createBroker(config);
  const response = await send(broker, 'status');
  assert.equal(response.ok, true);
  assert.equal(response.data.protocol, 1);
  assert.equal(response.data.serverId, 'srv-test01');
  assert.equal(response.data.workspaceId, 'ws-dev');
  assert.equal(response.data.writable, true);
  assert.equal(response.data.lease, null);
  assert.deepEqual(response.data.tasks, ['tests']);
  broker.close();
});

test('租约：单写者冲突、同 owner 续租、过期后释放', async () => {
  let now = 1_000;
  const { config } = setup({ clock: () => now, leaseTtlMs: 1_000 });
  const broker = createBroker(config);
  const acquired = await send(broker, 'lease-acquire', { owner: 'dev-a' });
  assert.equal(acquired.ok, true);
  const leaseId = acquired.data.lease.id;
  assert.match(leaseId, /^lease-[a-z0-9]+$/);

  const conflict = await send(broker, 'lease-acquire', { owner: 'dev-b' });
  assert.equal(codeOf(conflict), 'LEASE_CONFLICT');

  const renewed = await send(broker, 'lease-acquire', { owner: 'dev-a' });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.data.lease.id, leaseId);

  now += 2_000; // 租约过期：旧 leaseId 不能再写
  const expiredApply = await send(broker, 'apply', {
    path: 'old.txt', content: 'x', expectedHash: null, operationId: 'op-oldlease-001',
  }, leaseId);
  assert.equal(codeOf(expiredApply), 'LEASE_REQUIRED');

  const takeover = await send(broker, 'lease-acquire', { owner: 'dev-b' });
  assert.equal(takeover.ok, true);
  assert.notEqual(takeover.data.lease.id, leaseId);
  broker.close();
});

test('lease-release：不匹配的 leaseId 被拒，释放后写操作回到 LEASE_REQUIRED', async () => {
  const { config } = setup();
  const broker = createBroker(config);
  const acquired = await send(broker, 'lease-acquire', { owner: 'dev-a' });
  const leaseId = acquired.data.lease.id;
  const mismatch = await send(broker, 'lease-release', {}, 'lease-0000000000000000');
  assert.equal(codeOf(mismatch), 'LEASE_CONFLICT');
  const released = await send(broker, 'lease-release', {}, leaseId);
  assert.deepEqual(released.data, { released: true });
  const afterRelease = await send(broker, 'apply', {
    path: 'a.txt', content: 'x', expectedHash: null, operationId: 'op-released-001',
  }, leaseId);
  assert.equal(codeOf(afterRelease), 'LEASE_REQUIRED');
  broker.close();
});

test('apply：持租约写入、同 operationId 幂等、未持租约被拒', async () => {
  const { root, config } = setup();
  const broker = createBroker(config);
  const noLease = await send(broker, 'apply', { path: 'a.txt', content: 'x', expectedHash: null, operationId: 'op-no-lease-01' });
  assert.equal(codeOf(noLease), 'LEASE_REQUIRED');

  const acquired = await send(broker, 'lease-acquire', { owner: 'dev-a' });
  const leaseId = acquired.data.lease.id;
  const params = { path: 'a.txt', content: 'hello', expectedHash: null, operationId: 'op-broker-0001' };
  const first = await send(broker, 'apply', params, leaseId);
  assert.equal(first.ok, true);
  assert.equal(first.data.changed, true);
  const replay = await send(broker, 'apply', params, leaseId);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.changed, false);
  assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello');
  broker.close();
});

test('只读工作区：apply 回 WRITE_DISABLED', async () => {
  const { config } = setup({ writable: false });
  const broker = createBroker(config);
  const acquired = await send(broker, 'lease-acquire', { owner: 'dev-a' });
  const disabled = await send(broker, 'apply', {
    path: 'a.txt', content: 'x', expectedHash: null, operationId: 'op-readonly-001',
  }, acquired.data.lease.id);
  assert.equal(codeOf(disabled), 'WRITE_DISABLED');
  broker.close();
});

test('check：未预注册任务被拒，未知 jobId 回 JOB_NOT_FOUND', async () => {
  const { config } = setup({ tasks: { tests: { command: process.execPath, args: ['-e', ''] } } });
  const broker = createBroker(config);
  const unknownTask = await send(broker, 'check', { task: 'rm -rf /' });
  assert.equal(codeOf(unknownTask), 'UNKNOWN_TASK');
  const missingJob = await send(broker, 'job-status', { jobId: 'job-0000000000000000' });
  assert.equal(codeOf(missingJob), 'JOB_NOT_FOUND');
  broker.close();
});

test('job：取消运行中任务、超时后标记 failed 并写清原因', async () => {
  const { config } = setup({
    tasks: {
      'long-job': { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 30000 },
      'slow-job': { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 800 },
    },
  });
  const broker = createBroker(config);
  const started = await send(broker, 'check', { task: 'long-job' });
  assert.equal(started.ok, true);
  const cancelled = await send(broker, 'job-cancel', { jobId: started.data.jobId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.data.status, 'cancelled');

  const timed = await send(broker, 'check', { task: 'slow-job' });
  assert.equal(timed.ok, true);
  const failed = await waitFor(async () => {
    const status = await send(broker, 'job-status', { jobId: timed.data.jobId });
    return status.ok && status.data.status === 'failed' ? status.data : null;
  });
  assert.match(failed.output, /超时/);
  broker.close();
});

test('release-request：幂等、哈希稳定、缺检查记录被拒、内容变化换 id', async () => {
  const { root, config } = setup();
  writeFileSync(path.join(root, 'readme.txt'), 'v1');
  const broker = createBroker(config);
  const checks = [{ task: 'tests', ok: true, at: 1, outputDigest: null }];
  const first = await send(broker, 'release-request', { requestedBy: 'dev-a', checks });
  assert.equal(first.ok, true);
  assert.equal(first.data.duplicate, false);
  assert.match(first.data.releaseId, /^rel-[a-z0-9]{12}$/);
  const inboxFile = path.join(config.releaseInbox, `${first.data.releaseId}.json`);
  assert.equal(existsSync(inboxFile), true);

  const second = await send(broker, 'release-request', { requestedBy: 'dev-a', checks });
  assert.equal(second.ok, true);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.releaseId, first.data.releaseId);
  assert.equal(second.data.contentDigest, first.data.contentDigest);
  // profileId 必须来自配置（客户端档案 id），不能是 serverId；否则审批侧会按 FORBIDDEN 拒。
  const stored = JSON.parse(readFileSync(inboxFile, 'utf8'));
  assert.equal(stored.frozenHash, first.data.frozenHash);
  assert.equal(stored.profileId, 'prod');
  assert.equal(stored.profileId === config.serverId, false);

  const noChecks = await send(broker, 'release-request', { requestedBy: 'dev-a', checks: [] });
  assert.equal(codeOf(noChecks), 'INVALID_REQUEST');

  writeFileSync(path.join(root, 'readme.txt'), 'v2');
  const third = await send(broker, 'release-request', { requestedBy: 'dev-a', checks });
  assert.equal(third.ok, true);
  assert.notEqual(third.data.releaseId, first.data.releaseId);
  broker.close();
});

test('协议与参数：空行、坏 JSON、版本不符、未知 op', async () => {
  const { config } = setup();
  const broker = createBroker(config);
  assert.equal(await broker.handleLine('   '), null);

  const badJson = JSON.parse(await broker.handleLine('{oops'));
  assert.equal(badJson.error.code, 'INVALID_REQUEST');

  const mismatch = JSON.parse(await broker.handleLine(JSON.stringify({ v: 2, id: 7, op: 'status', params: {} })));
  assert.equal(mismatch.error.code, 'PROTOCOL_MISMATCH');
  assert.equal(mismatch.id, 7);

  const unknownOp = await send(broker, 'nope', {});
  assert.equal(codeOf(unknownOp), 'INVALID_REQUEST');
  broker.close();
});

test('路径与 git：穿越被拒，非 git 仓库给明确错误而不崩', async () => {
  const { config } = setup();
  const broker = createBroker(config);
  const escape = await send(broker, 'read', { path: '../outside.txt' });
  assert.equal(codeOf(escape), 'PATH_OUT_OF_SCOPE');

  const status = await send(broker, 'git-status');
  assert.equal(status.ok, false);
  assert.equal(status.error.code, 'INTERNAL');
  assert.match(status.error.message, /git/);

  const diff = await send(broker, 'git-diff', {});
  assert.equal(diff.ok, false);
  broker.close();
});

test('入口配置：缺 profileId 退出 1，不默认成 serverId 或空串', () => {
  const base = path.join(TMP, 'missing-profile');
  mkdirSync(base, { recursive: true });
  const configFile = path.join(base, 'broker.json');
  writeFileSync(configFile, JSON.stringify({
    serverId: 'srv-test01', workspaceId: 'ws-dev', root: base,
    stateDir: path.join(base, 'state'), releaseInbox: path.join(base, 'inbox'), writable: true, tasks: {},
  }));
  const entry = fileURLToPath(new URL('../bin/airlock-broker.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--config', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /profileId/);
});
