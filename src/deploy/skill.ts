/**
 * 在项目里落一份 agent 能直接读到的 airlock 规范。
 *
 * 为什么需要：airlock 自带 `skills/airlock-deploy/SKILL.md`，但它躺在
 * `node_modules/airlock/` 里；agent 的 skill 扫描路径是 `~/.dsh/skills/` 与
 * `<项目>/.dsh/skills/`，两边不通——「规范随包分发」实际等于「看不见」。
 * 这个命令把包内规范复制进项目，并把本项目的档案、落点与数据保护写成一节。
 *
 * 生成的文件带标记行；没有标记的同名文件不会被覆盖（那是用户自己写的）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SKILL_MARKER = '<!-- airlock:generated -->';
export const SKILL_RELATIVE = join('.dsh', 'skills', 'airlock-deploy', 'SKILL.md');

/** 写进「本项目」小节的已知事实；取不到的留空，由人补。 */
export interface ProjectFacts {
  readonly version: string;
  readonly profile?: string;
  readonly server?: string;
  readonly app?: string;
  readonly workspace?: string;
  readonly root?: string | null;
  readonly layout?: string | null;
  readonly sharedPaths?: readonly string[];
  readonly preservePaths?: readonly string[];
  /** 连不上服务器或档案不可用时的原因，写进文件让人知道该补什么。 */
  readonly note?: string;
}

function codeList(items: readonly string[] | undefined): string {
  if (items === undefined || items.length === 0) return '（未配）';
  return items.map(item => `\`${item}\``).join('、');
}

export function renderProjectSkill(generic: string, facts: ProjectFacts): string {
  const lines = [
    SKILL_MARKER,
    '',
    generic.trimEnd(),
    '',
    '---',
    '',
    '## 本项目',
    '',
    `由 \`airlock-deploy skill install\` 生成（airlock v${facts.version}）。`,
    '上面是通用规范，重新执行该命令会刷新它；**项目差异写在本节**。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| profile | ${facts.profile ?? '（未指定）'} |`,
    `| 服务器 | ${facts.server ?? '（未取到）'} |`,
    `| app | ${facts.app ?? '（未指定）'} |`,
    `| 本地工作区 | ${facts.workspace ?? '（未指定）'} |`,
    `| 服务器落点 | ${facts.root ?? '（未取到）'} |`,
    `| 布局 | ${facts.layout ?? '（未取到）'} |`,
    `| sharedPaths | ${codeList(facts.sharedPaths)} |`,
    `| preservePaths | ${codeList(facts.preservePaths)} |`,
    '',
    '发版：`airlock-deploy release --app <应用>`，或项目自己的封装脚本（必须走同一个部署器协议）。',
    '',
    ...(facts.note === undefined ? [] : [`> 生成时未能连上部署器：${facts.note}`, '> 上表的落点、布局与保护路径需要在服务器可达后补填。', '']),
  ];
  return `${lines.join('\n')}\n`;
}

export interface InstallResult {
  readonly path: string;
  readonly status: 'created' | 'updated' | 'unchanged' | 'refused';
}

/**
 * 写项目 skill。已存在且不是本命令生成的（没有标记行）时拒绝覆盖——
 * 那可能是用户手写的规范，覆盖比不写更糟。
 */
export async function installProjectSkill(options: {
  projectDir: string;
  content: string;
  force?: boolean;
}): Promise<InstallResult> {
  const path = join(options.projectDir, SKILL_RELATIVE);
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === null) {
    await mkdir(join(options.projectDir, '.dsh', 'skills', 'airlock-deploy'), { recursive: true });
    await writeFile(path, options.content, 'utf8');
    return { path, status: 'created' };
  }
  if (!existing.includes(SKILL_MARKER) && options.force !== true) {
    return { path, status: 'refused' };
  }
  if (existing === options.content) return { path, status: 'unchanged' };
  await writeFile(path, options.content, 'utf8');
  return { path, status: 'updated' };
}
