/**
 * 服务器系统信息（sysinfo op）：控制台「系统」那一栏的数据来源。
 *
 * 要点：报的是**服务器自己**的平台，不是客户端的；只读、不碰应用目录；
 * 配置里显式写了 kind 就按配置走，不去猜宿主。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/deploy/context.ts';
import { sysinfoOfServer } from '../src/deploy/inspect.ts';
import { deployRequestSchema } from '../src/deploy/contracts.ts';

function context(kind) {
  const config = { serverId: 'srv-test01', apps: {}, ...(kind === undefined ? {} : { kind }) };
  return createContext(config, () => 0);
}

test('sysinfo 报服务器自己的平台，不是客户端平台', async () => {
  const info = await sysinfoOfServer(context());
  assert.equal(info.serverId, 'srv-test01');
  assert.equal(info.kind, process.platform === 'win32' ? 'windows' : 'linux');
  assert.equal(info.platform, process.platform);
  assert.ok(typeof info.arch === 'string' && info.arch.length > 0, 'arch 不能为空');
  assert.ok(typeof info.kernel === 'string' && info.kernel.length > 0, 'kernel 不能为空');
  assert.ok(typeof info.hostname === 'string' && info.hostname.length > 0, 'hostname 不能为空');
  assert.match(info.node, /^v\d+\./, 'node 要能看出主版本');
});

test('Linux 上带发行版信息，Windows 上不读 /etc/os-release', async () => {
  const info = await sysinfoOfServer(context());
  assert.ok(typeof info.osName === 'string' && info.osName.length > 0, 'osName 必须有值');
  if (info.kind === 'linux') {
    // 极简镜像可能没有 os-release，那时只有内核版本兜底。
    if (info.osVersion !== null) assert.match(info.osVersion, /^[0-9]/);
  } else {
    assert.equal(info.osVersion, null, 'Windows 没有 VERSION_ID 这个字段');
  }
});

test('配置里显式写 kind 时以配置为准', async () => {
  const info = await sysinfoOfServer(context('windows'));
  assert.equal(info.kind, 'windows');
  assert.equal(info.osVersion, null, 'kind=windows 就不该去读 os-release');
});

test('sysinfo 是协议里的合法 op，且不需要 app 参数', () => {
  assert.equal(deployRequestSchema.safeParse({ v: 1, id: 1, op: 'sysinfo' }).success, true);
  assert.equal(deployRequestSchema.safeParse({ v: 1, id: 1, op: 'nope' }).success, false);
});
