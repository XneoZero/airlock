import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { StreamReader, parseRequest } from '../src/deploy/protocol.ts';

test('先读一行 JSON，再按长度读二进制', async () => {
  const stream = new PassThrough();
  const reader = new StreamReader(stream);
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  stream.write(`${JSON.stringify({ v: 1, id: 1, op: 'install', app: 'web', archiveSize: 5 })}\n`);
  stream.write(payload);
  stream.end();

  const line = await reader.readLine();
  assert.ok(line !== null);
  const request = parseRequest(line);
  assert.equal(request.op, 'install');
  assert.equal(request.archiveSize, 5);

  const bytes = await reader.readBytes(5);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
  assert.equal(await reader.readLine(), null);
});

test('二进制内容里出现换行不会破坏行读取', async () => {
  const stream = new PassThrough();
  const reader = new StreamReader(stream);
  stream.write('{"v":1,"id":2,"op":"status"}\n');
  stream.write(Buffer.from([0x0a, 0x0a, 0x0a]));
  stream.end();

  const line = await reader.readLine();
  assert.equal(JSON.parse(line).op, 'status');
  const bytes = await reader.readBytes(3);
  assert.deepEqual([...bytes], [10, 10, 10]);
});

test('跨 chunk 边界的行与字节都能正确切分', async () => {
  const stream = new PassThrough();
  const reader = new StreamReader(stream);
  setTimeout(() => {
    stream.write('{"v":1,"id":3,"op":"status","app":"we');
    setTimeout(() => {
      stream.write('b"}\n');
      stream.write(Buffer.from([9, 9]));
      stream.end();
    }, 5);
  }, 5);

  const line = await reader.readLine();
  const request = parseRequest(line);
  assert.equal(request.app, 'web');
  assert.deepEqual([...(await reader.readBytes(2))], [9, 9]);
});

test('非法请求给出明确错误而不是崩溃', () => {
  assert.throws(() => parseRequest('not json'), /合法 JSON/);
  assert.throws(() => parseRequest('{"v":1,"id":1,"op":"nope"}'), /契约/);
  assert.throws(() => parseRequest('{"v":9,"id":1,"op":"status"}'), /契约/);
});

test('声明长度大于实际数据时报错', async () => {
  const stream = new PassThrough();
  const reader = new StreamReader(stream);
  stream.write('{"v":1,"id":4,"op":"install","archiveSize":10}\n');
  stream.end(Buffer.from([1, 2, 3]));
  await reader.readLine();
  await assert.rejects(() => reader.readBytes(10), /期望 10 字节/);
});
