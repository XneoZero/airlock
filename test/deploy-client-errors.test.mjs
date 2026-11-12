/**
 * 连不上服务器时，报错要直接说「下一步查什么」。
 *
 * 以前只把 ssh 的 stderr 原样贴出来，agent 和人都得自己判断是
 * 「sshd 没起」「安全组没放行」还是「AllowGroups 没配」。这几种处理办法完全不同。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainSshFailure } from '../src/deploy/client.ts';

test('连接被拒绝：指向 sshd 没起来', () => {
  const message = explainSshFailure('ssh: connect to host 1.2.3.4 port 22: Connection refused\r\n', 255);
  assert.match(message, /22 端口没有监听/);
  assert.match(message, /sshd 没启动/);
});

test('连接超时：指向安全组/防火墙', () => {
  const message = explainSshFailure('ssh: connect to host 1.2.3.4 port 22: Connection timed out', 255);
  assert.match(message, /连接超时/);
  assert.match(message, /安全组或防火墙/);
});

test('认证被拒：把密钥、AllowGroups、ForceCommand 一起点名', () => {
  const message = explainSshFailure('ag-ssh@1.2.3.4: Permission denied (publickey,password).', 255);
  assert.match(message, /认证被拒/);
  assert.match(message, /AllowGroups/);
});

test('主机键变了：给出 ssh-keygen -R', () => {
  const message = explainSshFailure('@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 255);
  assert.match(message, /ssh-keygen -R/);
});

test('认不出来的 stderr：原文带前几行，不丢信息', () => {
  const message = explainSshFailure('kex_exchange_identification: banner exchange timeout', 255);
  assert.match(message, /ssh 退出码 255/);
  assert.match(message, /kex_exchange_identification/);
});
