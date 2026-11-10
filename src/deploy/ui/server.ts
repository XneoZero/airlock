/**
 * 本地 Web 控制台：只绑 127.0.0.1，用一次性 token 防 CSRF。
 *
 * 支持多项目：每个项目 = 一个档案（服务器）+ 一个应用 + 一个本地目录。
 * 能做的只有三件事：看（overview）、发（release）、退（rollback）。
 * 不提供删除版本、改配置、执行任意命令的入口——控制台不是第二个 shell。
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadProfileTable, packRelease } from '../local.ts';
import { DeployError } from '../errors.ts';
import { createDeployClient, type DeployClient } from '../client.ts';
import type { DeployProfile, DeployServer } from '../contracts.ts';
import { renderPage } from './page.ts';

const execFileAsync = promisify(execFile);
const MAX_BODY = 1_000_000;

/** 一个可切换的项目：档案（连哪台服务器）+ 应用 + 本地目录。 */
export interface UiProject {
  readonly name: string;
  readonly app: string;
  readonly workspace: string;
  readonly profile: DeployProfile;
}

export interface UiOptions {
  readonly projects: readonly UiProject[];
  /** 所有可选服务器（档案里的 servers 段）。控制台右上角切换。 */
  readonly servers?: Record<string, DeployServer>;
  readonly defaultProject: string;
  /** 默认选中的服务器名；不给就用项目档案自己的连接。 */
  readonly defaultServer?: string;
  readonly token: string;
  readonly port?: number;
  /** 可写回的档案文件路径；为空时「添加项目」不可用（例如档案来自内联 JSON）。 */
  readonly profileFile?: string;
  /** 新项目继承的连接信息（host/user/key 等）。 */
  readonly baseProfile?: DeployProfile;
  /** 本机 Airlock 安装目录，写进「接入新服务器」的提示词。 */
  readonly airlockRoot?: string;
  /** 实际生效的档案文件（真实路径才会传），提示词里要写它而不是猜一个位置。 */
  readonly profilesFile?: string;
  /** 启动时传入的 --profiles；重读档案要用同一个来源。 */
  readonly profilesPath?: string;
  /** 档案里没写 app 时的兜底值（启动参数 --app）。 */
  readonly fallbackApp?: string;
  readonly onProjectsChanged?: (projects: UiProject[]) => void;
}

export interface UiServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** 常见构建产物目录名。按出现顺序排，前面的更可能是用户想要的。 */
const CANDIDATE_DIRS = ['dist', 'build', 'out', 'publish', 'release', 'public', 'target', '.next', '.output', 'bin'];

export interface Candidate {
  readonly path: string;
  readonly label: string;
  readonly files: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new DeployError('INVALID_REQUEST', '请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    throw new DeployError('INVALID_REQUEST', '请求体不是合法 JSON');
  }
}

function countEntries(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * 扫描 workspace 下常见的产物目录，给发布弹窗做下拉。
 * 只认「存在且是目录」的，不递归统计大小——发布前扫一遍大目录会让弹窗卡住。
 * workspace 本身永远排第一（很多项目直接发布根目录，或 workspace 已经指向 dist）。
 */
function listCandidates(workspace: string): Candidate[] {
  const result: Candidate[] = [];
  if (existsSync(workspace)) {
    result.push({ path: workspace, label: '项目根', files: countEntries(workspace) });
  }
  for (const name of CANDIDATE_DIRS) {
    const abs = join(workspace, name);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        result.push({ path: abs, label: name, files: countEntries(abs) });
      }
    } catch {
      /* 权限不够就跳过，不影响其它候选 */
    }
  }
  return result;
}

/**
 * 弹 Windows 原生「选择文件夹」对话框。
 * 说明：DSH 这类后台 shell 环境通常没有交互式窗口站，原生对话框弹不出来，
 * 所以这个接口只在对端有桌面时可用；前端会先试它，失败就退回浏览器的文件夹选择器。
 */
async function pickFolder(): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new DeployError('INVALID_REQUEST', '原生文件夹对话框目前只支持 Windows');
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择要发布的本地项目目录'",
    '$dialog.ShowNewFolderButton = $true',
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true,
      timeout: 60_000,
    });
    const picked = stdout.trim();
    if (picked === '') {
      throw new DeployError('INTERNAL', '没有拿到路径：这个环境的 PowerShell 无法显示窗口（后台会话），请用浏览器选择或手动输入');
    }
    return picked;
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError('INTERNAL', `打开文件夹对话框失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 拖拽/浏览器选择只能拿到文件夹名，就在常用位置找同名目录。
 * 范围：用户常用子目录、用户目录本身、系统临时目录、各盘符根与两层子目录。
 * 只扫两层，避免把「选择文件夹」拖成磁盘遍历。
 */
const SEARCH_ROOTS = ['Desktop', 'Documents', 'Downloads', 'Projects', 'project', 'work', 'code', 'src', 'dev', 'repos'];
const SEARCH_DRIVES = ['C:', 'D:', 'E:', 'F:'];

function findFoldersByName(name: string): string[] {
  const wanted = name.toLowerCase();
  const roots: string[] = [];
  const seenRoot = new Set<string>();
  const push = (dir: string): void => {
    if (seenRoot.has(dir) || !existsSync(dir)) return;
    seenRoot.add(dir);
    roots.push(dir);
  };

  for (const sub of SEARCH_ROOTS) push(join(homedir(), sub));
  push(homedir());
  push(tmpdir());
  for (const drive of SEARCH_DRIVES) {
    push(`${drive}\\`);
    for (const sub of ['work', 'Projects', 'code', 'dev']) push(join(`${drive}\\`, sub));
  }

  const found: string[] = [];
  const seen = new Set<string>();
  const record = (abs: string): void => {
    if (found.length >= 8 || seen.has(abs)) return;
    found.push(abs);
    seen.add(abs);
  };

  for (const root of roots) {
    if (found.length >= 8) break;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= 8) break;
      const abs = join(root, entry);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (entry.toLowerCase() === wanted) {
        record(abs);
        continue;
      }
      // 再往下一层找（项目常放在 D:\work\<项目> 这种位置）
      let children: string[] = [];
      try {
        children = readdirSync(abs);
      } catch {
        continue;
      }
      for (const child of children) {
        if (found.length >= 8) break;
        if (child.toLowerCase() !== wanted) continue;
        const childAbs = join(abs, child);
        try {
          if (statSync(childAbs).isDirectory()) record(childAbs);
        } catch {
          /* 跳过不可读的 */
        }
      }
    }
  }
  return found;
}

/** 本地项目最近的提交。不是 git 仓库就返回空数组，不报错。 */async function gitLog(workspace: string, limit = 15): Promise<Array<{ hash: string; date: string; author: string; subject: string }>> {
  if (!existsSync(workspace)) return [];
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', workspace, 'log', `-${limit}`, '--pretty=format:%h%x1f%ad%x1f%an%x1f%s', '--date=format:%Y-%m-%d %H:%M',
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout.split(/\r?\n/).filter(line => line.trim() !== '').map(line => {
      const [hash, date, author, subject] = line.split('\x1f');
      return { hash: hash ?? '', date: date ?? '', author: author ?? '', subject: subject ?? '' };
    });
  } catch {
    return [];
  }
}

async function gitStatus(workspace: string): Promise<{ clean: boolean; dirty: number }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, 'status', '--porcelain'], { windowsHide: true });
    const lines = stdout.split(/\r?\n/).filter(line => line.trim() !== '');
    return { clean: lines.length === 0, dirty: lines.length };
  } catch {
    return { clean: true, dirty: 0 };
  }
}

export async function startUiServer(options: UiOptions): Promise<UiServer> {
  const { token } = options;
  let projects: UiProject[] = [...options.projects];
  let servers: Record<string, DeployServer> = { ...(options.servers ?? {}) };
  const clients = new Map<string, DeployClient>();
  let releaseInFlight = false;
  let reloadError = '';

  /**
   * 重读档案：用户很可能在控制台开着的时候改档案加服务器/项目。
   * 读失败就保留启动时那份（别把整个控制台搞挂），把错误挂出来给前端提示。
   */
  function reloadTable(): void {
    let table;
    try {
      const override = options.profilesPath;
      table = loadProfileTable(override === undefined || override === '' ? undefined : override);
    } catch (error) {
      reloadError = error instanceof Error ? error.message : String(error);
      return;
    }
    reloadError = '';
    const next: UiProject[] = [];
    for (const [name, profile] of Object.entries(table.table.profiles)) {
      const app = profile.app ?? options.fallbackApp;
      if (app === undefined || app === '') continue;
      next.push({
        name,
        app,
        workspace: resolve(table.baseDir, profile.workspace ?? '.'),
        profile,
      });
    }
    if (next.length > 0) {
      // 目录可能被删掉了，别留下打不开的项目。
      projects = next.filter(item => existsSync(item.workspace));
      if (projects.length === 0) projects = next;
    }
    servers = { ...table.table.servers };
    // 客户端缓存按 host 复用，档案改了之后旧的连接对象可能指向已删除的服务器。
    clients.clear();
  }

  /**
   * 追加一个项目：写回档案文件，然后重建内存里的项目列表。
   * 只接受「本地目录存在」的路径，避免写进去一个打不开的项目。
   */
  async function addProject(body: Record<string, unknown>): Promise<{ name: string; project: UiProject }> {
    const file = options.profileFile;
    if (file === undefined || file === '') {
      throw new DeployError('INVALID_REQUEST', '当前档案来自环境变量或内联 JSON，无法写回。用 --profiles <文件> 启动控制台才能添加项目。');
    }
    if (options.baseProfile === undefined) {
      throw new DeployError('INVALID_REQUEST', '没有可用于继承的连接信息');
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const app = typeof body.app === 'string' ? body.app.trim() : '';
    const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) {
      throw new DeployError('INVALID_REQUEST', '项目名只能用字母、数字、连字符（1-64 位）');
    }
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(app)) {
      throw new DeployError('INVALID_REQUEST', '应用 id 必须小写字母开头，2-32 位字母数字与连字符');
    }
    if (workspace === '') throw new DeployError('INVALID_REQUEST', '需要选择项目目录');
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new DeployError('INVALID_REQUEST', `目录不存在：${workspace}`);
    }
    if (projects.some(item => item.name === name)) {
      throw new DeployError('INVALID_REQUEST', `项目已存在：${name}`);
    }

    const raw = JSON.parse(readFileSync(file, 'utf8')) as { default?: string; profiles: Record<string, DeployProfile> };
    if (raw.profiles === undefined || typeof raw.profiles !== 'object') {
      throw new DeployError('INVALID_REQUEST', '档案文件结构不对，缺少 profiles');
    }
    raw.profiles[name] = { ...options.baseProfile, app, workspace };
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const project: UiProject = { name, app, workspace, profile: raw.profiles[name] };
    projects = [...projects, project];
    options.onProjectsChanged?.(projects);
    return { name, project };
  }

  function resolveProject(raw: unknown): UiProject {
    const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : options.defaultProject;
    const project = projects.find(item => item.name === name);
    if (project === undefined) {
      throw new DeployError('INVALID_REQUEST', `未知项目：${name}`, { projects: projects.map(item => item.name).join(',') });
    }
    return project;
  }

  /**
   * 同一个项目可以发到不同服务器：只换连接信息，应用 id 跟项目走。
   * 不传服务器名就用项目档案自己那份（老档案没有 servers 段时就是这条路）。
   */
  function serverProfile(project: UiProject, serverId: unknown): DeployProfile {
    const key = typeof serverId === 'string' ? serverId.trim() : '';
    if (key === '') return project.profile;
    const server = servers[key];
    if (server === undefined) {
      const known = Object.keys(servers).join(', ') || '（空）';
      throw new DeployError('INVALID_REQUEST', `未知服务器：${key}。已配置：${known}`);
    }
    return { ...server, app: project.app };
  }

  /** 客户端按「项目 + 服务器」缓存：同一台机器同一账号才能复用。 */
  function clientFor(project: UiProject, serverId?: unknown): DeployClient {
    const profile = serverProfile(project, serverId);
    const cacheKey = `${project.name}@${profile.host}:${profile.user ?? ''}:${profile.port ?? 22}`;
    let client = clients.get(cacheKey);
    if (client === undefined) {
      client = createDeployClient({ profile });
      clients.set(cacheKey, client);
    }
    return client;
  }

  function serverSummary() {
    return Object.entries(servers).map(([id, server]) => ({
      id,
      host: server.host,
      user: server.user ?? null,
      serverId: server.serverId ?? null,
    }));
  }

  function projectSummary() {
    return projects.map(project => ({
      name: project.name,
      app: project.app,
      workspace: project.workspace,
      serverId: project.profile.serverId ?? null,
      host: project.profile.host,
    }));
  }

  async function handleOverview(project: UiProject, serverId: unknown, response: ServerResponse): Promise<void> {
    const client = clientFor(project, serverId);
    const [status, list, git, dirty] = await Promise.all([
      client.call({ op: 'status', app: project.app }).catch(error => ({ error: error instanceof Error ? error.message : String(error) })),
      client.call({ op: 'list', app: project.app }).catch(() => null),
      gitLog(project.workspace),
      gitStatus(project.workspace),
    ]);
    const statusData = status as Record<string, unknown>;
    const listData = list as Record<string, unknown> | null;
    let log: string[] = [];
    try {
      const logs = await client.call({ op: 'logs', app: project.app, params: { lines: 40 } }) as { lines?: string[] };
      log = Array.isArray(logs.lines) ? logs.lines.slice(-20) : [];
    } catch { /* 日志取不到不影响主视图 */ }

    json(response, 200, {
      ok: true,
      project: project.name,
      projects: projectSummary(),
      servers: serverSummary(),
      selectedServer: typeof serverId === 'string' ? serverId : '',
      profilesFile: options.profilesFile ?? '',
      reloadError,
      app: project.app,
      workspace: project.workspace,
      candidates: listCandidates(project.workspace),
      server: (statusData as { error?: string }).error === undefined
        ? {
            serverId: statusData.serverId ?? null,
            kind: statusData.kind ?? null,
            root: statusData.root ?? null,
            current: statusData.current ?? null,
            consistent: statusData.consistent ?? null,
          }
        : { error: (statusData as { error: string }).error },
      releases: listData?.releases ?? [],
      history: listData?.history ?? [],
      git,
      gitStatus: dirty,
      log,
    });
  }

  async function handleRelease(project: UiProject, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    if (releaseInFlight) {
      json(response, 409, { ok: false, error: { code: 'BUSY', message: '已有一次发布在进行中' } });
      return;
    }
    const source = typeof body.source === 'string' && body.source.trim() !== '' ? body.source.trim() : project.workspace;
    const version = typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : undefined;
    const client = clientFor(project, body.server);
    releaseInFlight = true;
    try {
      const packed = await packRelease({ sourceDir: source, ...(version === undefined ? {} : { version }) });
      try {
        const installed = await client.call({
          op: 'install', app: project.app,
          params: { version: packed.version, manifestHash: packed.manifest.totalHash, commit: packed.commit },
          archive: { file: packed.archive, size: packed.bytes },
          timeoutMs: 20 * 60_000,
        });
        const activated = await client.call({ op: 'activate', app: project.app, params: { version: packed.version }, timeoutMs: 20 * 60_000 });
        json(response, 200, { ok: true, project: project.name, version: packed.version, manifestHash: packed.manifest.totalHash, installed, activated });
      } finally {
        await packed.cleanup();
      }
    } finally {
      releaseInFlight = false;
    }
  }

  async function handleRollback(project: UiProject, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    if (releaseInFlight) {
      json(response, 409, { ok: false, error: { code: 'BUSY', message: '发布进行中，暂不能回滚' } });
      return;
    }
    const to = typeof body.to === 'string' && body.to.trim() !== '' ? body.to.trim() : undefined;
    const restoreBackup = body.restoreBackup === true;
    const client = clientFor(project, body.server);
    releaseInFlight = true;
    try {
      const result = await client.call({
        op: 'rollback', app: project.app,
        params: { ...(to === undefined ? {} : { to }), ...(restoreBackup ? { restoreBackup: true } : {}) },
        timeoutMs: 10 * 60_000,
      });
      json(response, 200, { ok: true, project: project.name, result });
    } finally {
      releaseInFlight = false;
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port ?? 0}`);

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const page = renderPage({
          token,
          projects: projectSummary(),
          defaultProject: options.defaultProject,
          airlockRoot: options.airlockRoot ?? process.cwd(),
          profilesFile: options.profilesFile ?? '',
        });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(page);
        return;
      }

      // 浏览器会自动请求 favicon，它不带 token。回 204 免得刷一屏 401。
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204, { 'cache-control': 'public, max-age=86400' });
        response.end();
        return;
      }

      // 所有 API 都要 token：避免本机其他页面用表单/脚本撞进来发版。
      const provided = (request.headers['x-airlock-token'] as string | undefined) ?? url.searchParams.get('t') ?? '';
      if (provided !== token) {
        json(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'token 不正确' } });
        return;
      }

      // 每个 API 请求前重读档案：用户常开着控制台改 servers/profiles，不重读就看不到。
      reloadTable();

      if (request.method === 'GET' && url.pathname === '/api/overview') {
        await handleOverview(resolveProject(url.searchParams.get('project')), url.searchParams.get('server'), response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/pick-folder') {
        json(response, 200, { ok: true, path: await pickFolder() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/find-folder') {
        const body = await readBody(request);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') throw new DeployError('INVALID_REQUEST', '需要文件夹名');
        json(response, 200, { ok: true, paths: findFoldersByName(name) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/server-ls') {
        const project = resolveProject(url.searchParams.get('project'));
        const target = url.searchParams.get('path');
        const listing = await clientFor(project, url.searchParams.get('server')).call({
          op: 'list-dir',
          app: project.app,
          ...(target === null || target.trim() === '' ? {} : { params: { path: target.trim() } }),
        });
        json(response, 200, { ok: true, ...(listing as Record<string, unknown>) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/set-root') {
        const body = await readBody(request);
        const project = resolveProject(body.project);
        const root = typeof body.root === 'string' ? body.root.trim() : '';
        if (root === '') throw new DeployError('INVALID_REQUEST', '需要目标目录');
        const updated = await clientFor(project, body.server).call({ op: 'set-root', app: project.app, params: { root } });
        json(response, 200, { ok: true, ...(updated as Record<string, unknown>) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const body = await readBody(request);
        const created = await addProject(body);
        json(response, 200, { ok: true, name: created.name, project: { name: created.name, app: created.project.app, workspace: created.project.workspace } });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/release') {
        const body = await readBody(request);
        await handleRelease(resolveProject(body.project), body, response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/rollback') {
        const body = await readBody(request);
        await handleRollback(resolveProject(body.project), body, response);
        return;
      }
      json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口' } });
    })().catch((error: unknown) => {
      const code = error instanceof DeployError ? error.code : 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) json(response, 500, { ok: false, error: { code, message } });
      else response.end();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7788, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : (options.port ?? 7788));
    });
  });

  return {
    url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`,
    port,
    close: () => new Promise<void>(resolve => {
      // client 每次 call 都是一次独立 SSH，没有常驻连接要关。
      server.close(() => resolve());
    }),
  };
}
