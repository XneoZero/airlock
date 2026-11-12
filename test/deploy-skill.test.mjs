/**
 * skill install：把 airlock 的规范落到项目里，让 agent 真能读到。
 *
 * 背景：规范文件随 npm 包分发在 node_modules/airlock/skills/ 下，而 agent 的
 * skill 扫描路径是 <项目>/.dsh/skills/ —— 不落一份过去，等于没分发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProjectSkill, renderProjectSkill, SKILL_MARKER, SKILL_RELATIVE } from '../src/deploy/skill.ts';

const GENERIC = '## 通道纪律\n\n- 只用 airlock 的通道。\n';

test('renderProjectSkill：通用规范在前，本项目差异在后', () => {
  const text = renderProjectSkill(GENERIC, {
    version: '0.6.3',
    profile: 'web-prod',
    server: 'srv-prod02',
    app: 'web',
    workspace: 'C:/work/web',
    root: 'C:/Users/Administrator/Desktop/web',
    layout: 'mirror',
    sharedPaths: [],
    preservePaths: ['data', 'assets/img/uploads'],
  });

  assert.equal(text.startsWith(SKILL_MARKER), true, '首行要有生成标记，重复执行才不会覆盖手写文件');
  assert.match(text, /只用 airlock 的通道/);
  assert.match(text, /## 本项目/);
  assert.match(text, /\| profile \| web-prod \|/);
  assert.match(text, /\| 服务器落点 \| C:\/Users\/Administrator\/Desktop\/web \|/);
  assert.match(text, /`data`、`assets\/img\/uploads`/);
  assert.match(text, /\| sharedPaths \| （未配） \|/, '空列表要写明未配，不要留空白');
});

test('renderProjectSkill：连不上服务器时把原因写进文件', () => {
  const text = renderProjectSkill(GENERIC, { version: '0.6.3', note: 'ssh 连接被拒绝' });
  assert.match(text, /生成时未能连上部署器：ssh 连接被拒绝/);
  assert.match(text, /需要在服务器可达后补填/);
});

test('installProjectSkill：新建 → 重复执行 unchanged → 内容变了才更新', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-skill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const content = renderProjectSkill(GENERIC, { version: '0.6.3', profile: 'p1' });
  const first = await installProjectSkill({ projectDir: dir, content });
  assert.equal(first.status, 'created');
  assert.equal(await readFile(join(dir, SKILL_RELATIVE), 'utf8'), content);

  const again = await installProjectSkill({ projectDir: dir, content });
  assert.equal(again.status, 'unchanged', '同内容重复执行不该重写文件');

  const updated = await installProjectSkill({ projectDir: dir, content: renderProjectSkill(GENERIC, { version: '0.6.4', profile: 'p1' }) });
  assert.equal(updated.status, 'updated');
  assert.match(await readFile(join(dir, SKILL_RELATIVE), 'utf8'), /airlock v0\.6\.4/);
});

test('installProjectSkill：遇到手写的 SKILL.md 不覆盖，除非 --force', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-skill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, SKILL_RELATIVE);
  await mkdir(join(dir, '.dsh', 'skills', 'airlock-deploy'), { recursive: true });
  await writeFile(path, '# 我自己写的发版规范\n', 'utf8');

  const refused = await installProjectSkill({ projectDir: dir, content: renderProjectSkill(GENERIC, { version: '0.6.3' }) });
  assert.equal(refused.status, 'refused');
  assert.equal(await readFile(path, 'utf8'), '# 我自己写的发版规范\n', '没确认前不能动用户的文件');

  const forced = await installProjectSkill({ projectDir: dir, content: renderProjectSkill(GENERIC, { version: '0.6.3' }), force: true });
  assert.equal(forced.status, 'updated');
  assert.match(await readFile(path, 'utf8'), /airlock:generated/);
});
