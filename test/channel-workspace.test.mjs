/**
 * 工作区文件操作：路径逃逸、符号链接、超大文件、hash 冲突、operationId 幂等。
 * 全部在 mkdtemp 临时目录里跑，不读仓库里的任何真实工作区。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, contentDigest, createOperationLedger, list, read } from '../src/transports/remote-dev/workspace.ts';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'airlock-workspace-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let caseNo = 0;
/** 每个用例一个独立工作区 + 独立 stateDir（幂等记录不放工作区里）。 */
function freshWorkspace() {
  const base = path.join(TMP, `case-${(caseNo += 1)}`);
  const root = path.join(base, 'ws');
  mkdirSync(root, { recursive: true });
  return { root, stateDir: path.join(base, 'state') };
}

function errorCode(error) {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

test('list：排序、深度与条目上限', async () => {
  const { root } = freshWorkspace();
  writeFileSync(path.join(root, 'b.txt'), 'b');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  mkdirSync(path.join(root, 'dir', 'deep'), { recursive: true });
  writeFileSync(path.join(root, 'dir', 'deep', 'x.txt'), 'x');

  const shallow = await list(root, { maxDepth: 0 });
  assert.deepEqual(shallow.entries.map(entry => entry.path), ['a.txt', 'b.txt', 'dir']);
  assert.equal(shallow.entries.find(entry => entry.path === 'dir').kind, 'dir');

  const deep = await list(root);
  assert.ok(deep.entries.some(entry => entry.path === 'dir/deep/x.txt'));

  const capped = await list(root, { maxEntries: 2 });
  assert.equal(capped.entries.length, 2);
  assert.equal(capped.truncated, true);
});

test('read：正常读取与 hash，超限 TOO_LARGE，目录拒绝', async () => {
  const { root } = freshWorkspace();
  writeFileSync(path.join(root, 'note.txt'), '你好 workspace');
  const result = await read(root, 'note.txt');
  assert.equal(result.content, '你好 workspace');
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.truncated, false);

  writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(300 * 1024));
  await assert.rejects(() => read(root, 'big.txt'), (error) => errorCode(error) === 'TOO_LARGE');
  await assert.rejects(() => read(root, 'dir-does-not-exist'), (error) => errorCode(error) === 'INVALID_REQUEST');
});

test('路径穿越：绝对路径、.. 与 NUL 一律 PATH_OUT_OF_SCOPE', async () => {
  const { root } = freshWorkspace();
  await assert.rejects(() => read(root, '../outside.txt'), (error) => errorCode(error) === 'PATH_OUT_OF_SCOPE');
  await assert.rejects(() => read(root, 'sub/../../outside.txt'), (error) => errorCode(error) === 'PATH_OUT_OF_SCOPE');
  await assert.rejects(() => read(root, path.join(root, 'abs.txt')), (error) => errorCode(error) === 'PATH_OUT_OF_SCOPE');
  await assert.rejects(() => read(root, '/etc/passwd'), (error) => errorCode(error) === 'PATH_OUT_OF_SCOPE');
  await assert.rejects(() => read(root, 'a\u0000b'), (error) => errorCode(error) === 'PATH_OUT_OF_SCOPE');
});

test('符号链接：指向根外必须拒绝，list 不跟进', async (t) => {
  const { root } = freshWorkspace();
  const outside = path.join(TMP, `outside-${caseNo}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  try {
    symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch (error) {
    if (errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES') {
      t.skip('当前系统不允许创建符号链接');
      return;
    }
    throw error;
  }
  await assert.rejects(() => read(root, 'link/secret.txt'), (error) => errorCode(error) === 'PATH_OUT_OF_SCOPE');
  const listed = await list(root);
  assert.equal(listed.entries.find(entry => entry.path === 'link').kind, 'symlink');
  assert.equal(listed.entries.some(entry => entry.path.startsWith('link/')), false);
});

test('apply：新建、expectedHash 冲突、内容一致 changed=false', async () => {
  const { root, stateDir } = freshWorkspace();
  const ledger = createOperationLedger(stateDir);
  const created = await apply(root, 'a.txt', { content: 'one', expectedHash: null, operationId: 'op-create-0001' }, { ledger });
  assert.equal(created.changed, true);
  assert.equal(created.hashBefore, null);
  assert.equal(created.hashAfter.length, 64);

  await assert.rejects(
    () => apply(root, 'a.txt', { content: 'two', expectedHash: null, operationId: 'op-create-0002' }, { ledger }),
    (error) => errorCode(error) === 'HASH_MISMATCH',
  );
  await assert.rejects(
    () => apply(root, 'a.txt', { content: 'two', expectedHash: '0'.repeat(64), operationId: 'op-create-0003' }, { ledger }),
    (error) => errorCode(error) === 'HASH_MISMATCH',
  );
  const same = await apply(root, 'a.txt', { content: 'one', expectedHash: created.hashAfter, operationId: 'op-same-0004' }, { ledger });
  assert.equal(same.changed, false);
  assert.equal(same.hashAfter, created.hashAfter);
});

test('apply：operationId 幂等（跨 ledger 实例仍然命中）', async () => {
  const { root, stateDir } = freshWorkspace();
  const first = await apply(root, 'b.txt', { content: 'v1', expectedHash: null, operationId: 'op-idem-0001' }, { ledger: createOperationLedger(stateDir) });
  const replay = await apply(root, 'b.txt', { content: 'v2', expectedHash: first.hashAfter, operationId: 'op-idem-0001' }, { ledger: createOperationLedger(stateDir) });
  assert.equal(replay.changed, false);
  assert.equal(replay.hashAfter, first.hashAfter);
  assert.equal((await read(root, 'b.txt')).content, 'v1');
});

test('apply：edits 要求唯一命中，occurrence 指定第几处', async () => {
  const { root, stateDir } = freshWorkspace();
  const ledger = createOperationLedger(stateDir);
  const created = await apply(root, 'c.txt', { content: 'hello world hello', expectedHash: null, operationId: 'op-edit-0001' }, { ledger });
  await assert.rejects(
    () => apply(root, 'c.txt', { edits: [{ oldText: 'hello', newText: 'hi' }], expectedHash: created.hashAfter, operationId: 'op-edit-0002' }, { ledger }),
    (error) => errorCode(error) === 'HASH_MISMATCH',
  );
  const edited = await apply(root, 'c.txt', {
    edits: [{ oldText: 'hello', newText: 'hi', occurrence: 2 }], expectedHash: created.hashAfter, operationId: 'op-edit-0003',
  }, { ledger });
  assert.equal(edited.changed, true);
  assert.equal((await read(root, 'c.txt')).content, 'hello world hi');
});

test('apply：超限、二进制与参数组合都拒绝', async () => {
  const { root, stateDir } = freshWorkspace();
  const ledger = createOperationLedger(stateDir);
  await assert.rejects(
    () => apply(root, 'huge.txt', { content: 'x'.repeat(300 * 1024), expectedHash: null, operationId: 'op-huge-0001' }, { ledger }),
    (error) => errorCode(error) === 'TOO_LARGE',
  );
  await assert.rejects(
    () => apply(root, 'both.txt', { content: 'x', edits: [{ oldText: 'a', newText: 'b' }], expectedHash: null, operationId: 'op-both-0001' }, { ledger }),
    (error) => errorCode(error) === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => apply(root, 'bad.txt', { content: 'x', expectedHash: null, operationId: 'short' }, { ledger }),
    (error) => errorCode(error) === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => apply(root, '../escape.txt', { content: 'x', expectedHash: null, operationId: 'op-esc-0001' }, { ledger }),
    (error) => errorCode(error) === 'PATH_OUT_OF_SCOPE',
  );
});

test('幂等记录损坏：给 INTERNAL，不当作空表', async () => {
  const { root, stateDir } = freshWorkspace();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'apply-operations.json'), 'not json');
  const ledger = createOperationLedger(stateDir);
  await assert.rejects(() => ledger.get('a.txt', 'op-corrupt-01'), (error) => errorCode(error) === 'INTERNAL');
  await assert.rejects(
    () => apply(root, 'a.txt', { content: 'x', expectedHash: null, operationId: 'op-corrupt-02' }, { ledger }),
    (error) => errorCode(error) === 'INTERNAL',
  );
});

test('contentDigest：与文件创建顺序无关，内容变化即变', async () => {
  const { root } = freshWorkspace();
  writeFileSync(path.join(root, 'one.txt'), '1');
  writeFileSync(path.join(root, 'two.txt'), '2');
  const first = await contentDigest(root);
  const second = await contentDigest(root);
  assert.equal(first.digest, second.digest);
  assert.equal(first.files, 2);

  writeFileSync(path.join(root, 'two.txt'), '2-changed');
  const third = await contentDigest(root);
  assert.notEqual(third.digest, first.digest);
});
