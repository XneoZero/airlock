/**
 * 客户端：请求/响应配对、超时、版本不符、乱序未知 id 忽略、关闭时拒绝挂起请求。
 * 用内存假传输，不碰 ssh、不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteDevClient } from '../src/transports/remote-dev/client.ts';

function fakeTransport(respond) {
  const handlers = new Set();
  const sent = [];
  let closed = false;
  return {
    sent,
    isClosed: () => closed,
    emit(line) { for (const handler of handlers) handler(line); },
    transport: {
      send(line) {
        sent.push(line);
        respond?.(JSON.parse(line), (response) => {
          const text = JSON.stringify(response);
          for (const handler of handlers) handler(text);
        });
      },
      onLine(handler) { handlers.add(handler); return () => handlers.delete(handler); },
      close() { closed = true; },
    },
  };
}

const STATUS_DATA = {
  protocol: 1, serverId: 'srv-test01', workspaceId: 'ws-dev', root: '/tmp/ws',
  version: 'dev-broker/1', bootId: 'boot-test', writable: true, lease: null, tasks: [], observedAt: 1,
};

const codeOf = (error) => (error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined);

test('status：请求带 id/v，响应按 id 配对并校验契约', async () => {
  const fake = fakeTransport((request, reply) => {
    queueMicrotask(() => reply({ v: 1, id: request.id, ok: true, data: STATUS_DATA }));
  });
  const client = createRemoteDevClient({ transport: fake.transport });
  const status = await client.status();
  assert.equal(status.serverId, 'srv-test01');
  const sent = JSON.parse(fake.sent[0]);
  assert.equal(sent.v, 1);
  assert.equal(sent.op, 'status');
  assert.ok(Number.isInteger(sent.id));
  client.close();
});

test('超时：没有响应时给 TRANSPORT_TIMEOUT，而不是永远挂着', async () => {
  const fake = fakeTransport(() => {});
  const client = createRemoteDevClient({ transport: fake.transport, timeoutMs: 120 });
  await assert.rejects(() => client.status(), error => codeOf(error) === 'TRANSPORT_TIMEOUT');
  client.close();
});

test('协议版本不符：回 PROTOCOL_MISMATCH', async () => {
  const fake = fakeTransport((request, reply) => {
    queueMicrotask(() => reply({ v: 2, id: request.id, ok: true, data: STATUS_DATA }));
  });
  const client = createRemoteDevClient({ transport: fake.transport });
  await assert.rejects(() => client.status(), error => codeOf(error) === 'PROTOCOL_MISMATCH');
  client.close();
});

test('乱序/未知 id/非法行都忽略，正常响应仍能完成请求', async () => {
  const fake = fakeTransport(() => {});
  const client = createRemoteDevClient({ transport: fake.transport, timeoutMs: 2000 });
  const pending = client.status();
  fake.emit('这不是 JSON');
  fake.emit(JSON.stringify({ v: 1, id: 987_654, ok: true, data: { ignored: true } }));
  const requestId = JSON.parse(fake.sent[0]).id;
  fake.emit(JSON.stringify({ v: 1, id: requestId, ok: true, data: STATUS_DATA }));
  const status = await pending;
  assert.equal(status.workspaceId, 'ws-dev');
  client.close();
});

test('Broker 错误按码透传，不按 message 分支', async () => {
  const fake = fakeTransport((request, reply) => {
    queueMicrotask(() => reply({ v: 1, id: request.id, ok: false, error: { code: 'LEASE_REQUIRED', message: '先拿租约' } }));
  });
  const client = createRemoteDevClient({ transport: fake.transport });
  await assert.rejects(() => client.jobStatus('job-0000000000000000'), error => codeOf(error) === 'LEASE_REQUIRED');
  client.close();
});

test('未知 op 在本地拒绝，不发送', async () => {
  const fake = fakeTransport(() => {});
  const client = createRemoteDevClient({ transport: fake.transport });
  await assert.rejects(() => client.request('not-an-op'), error => codeOf(error) === 'INVALID_REQUEST');
  assert.equal(fake.sent.length, 0);
  client.close();
});

test('apply 未取租约时本地 LEASE_REQUIRED，取到后自动带 leaseId', async () => {
  const fake = fakeTransport((request, reply) => {
    queueMicrotask(() => {
      if (request.op === 'lease-acquire') {
        reply({ v: 1, id: request.id, ok: true, data: { lease: { id: 'lease-abcdefgh', owner: 'dev-a', expiresAt: 9_999_999_999_999 } } });
        return;
      }
      reply({
        v: 1, id: request.id, ok: true,
        data: { path: 'a.txt', hashBefore: null, hashAfter: 'a'.repeat(64), changed: true, operationId: request.params.operationId },
      });
    });
  });
  const client = createRemoteDevClient({ transport: fake.transport });
  await assert.rejects(
    () => client.apply({ path: 'a.txt', content: 'x', expectedHash: null, operationId: 'op-client-0001' }),
    error => codeOf(error) === 'LEASE_REQUIRED',
  );
  assert.equal(fake.sent.length, 0);

  const lease = await client.acquireLease('dev-a');
  assert.equal(lease.id, 'lease-abcdefgh');
  const applied = await client.apply({ path: 'a.txt', content: 'x', expectedHash: null, operationId: 'op-client-0002' });
  assert.equal(applied.changed, true);
  const last = JSON.parse(fake.sent.at(-1));
  assert.equal(last.op, 'apply');
  assert.equal(last.leaseId, 'lease-abcdefgh');
  client.close();
});

test('waitJob：轮询到终态，超时给 TRANSPORT_TIMEOUT', async () => {
  let polls = 0;
  const fake = fakeTransport((request, reply) => {
    polls += 1;
    queueMicrotask(() => reply({
      v: 1, id: request.id, ok: true,
      data: { jobId: 'job-abcdefgh', task: 'tests', status: polls < 3 ? 'running' : 'succeeded', startedAt: 1, finishedAt: polls < 3 ? null : 2, exitCode: 0, output: '' },
    }));
  });
  const client = createRemoteDevClient({ transport: fake.transport });
  const job = await client.waitJob('job-abcdefgh', { intervalMs: 20, timeoutMs: 2000 });
  assert.equal(job.status, 'succeeded');
  assert.ok(polls >= 3);
  client.close();
});

test('close：拒绝挂起请求并关闭传输', async () => {
  const fake = fakeTransport(() => {});
  const client = createRemoteDevClient({ transport: fake.transport, timeoutMs: 10_000 });
  const pending = client.status();
  client.close();
  await assert.rejects(pending, error => codeOf(error) === 'TRANSPORT_DISCONNECTED');
  assert.equal(fake.isClosed(), true);
});
