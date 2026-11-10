/**
 * 本地 Web 控制台：只绑 127.0.0.1，用一次性 token 防 CSRF。
 *
 * 支持多项目：每个项目 = 一个档案（服务器）+ 一个应用 + 一个本地目录。
 * 能做的只有三件事：看（overview）、发（release）、退（rollback）。
 * 不提供删除版本、改配置、执行任意命令的入口——控制台不是第二个 shell。
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { packRelease } from '../local.ts';
import { DeployError } from '../errors.ts';
import { createDeployClient, type DeployClient } from '../client.ts';
import type { DeployProfile } from '../contracts.ts';
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
  readonly defaultProject: string;
  readonly token: string;
  readonly port?: number;
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

/** 本地项目最近的提交。不是 git 仓库就返回空数组，不报错。 */
async function gitLog(workspace: string, limit = 15): Promise<Array<{ hash: string; date: string; author: string; subject: string }>> {
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
  const { projects, token } = options;
  const clients = new Map<string, DeployClient>();
  let releaseInFlight = false;

  function resolveProject(raw: unknown): UiProject {
    const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : options.defaultProject;
    const project = projects.find(item => item.name === name);
    if (project === undefined) {
      throw new DeployError('INVALID_REQUEST', `未知项目：${name}`, { projects: projects.map(item => item.name).join(',') });
    }
    return project;
  }

  /** 每个项目一个客户端；不同项目可能连不同服务器，不能复用。 */
  function clientFor(project: UiProject): DeployClient {
    let client = clients.get(project.name);
    if (client === undefined) {
      client = createDeployClient({ profile: project.profile });
      clients.set(project.name, client);
    }
    return client;
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

  async function handleOverview(project: UiProject, response: ServerResponse): Promise<void> {
    const client = clientFor(project);
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
      app: project.app,
      workspace: project.workspace,
      candidates: listCandidates(project.workspace),
      server: (statusData as { error?: string }).error === undefined
        ? { serverId: statusData.serverId ?? null, kind: statusData.kind ?? null, current: statusData.current ?? null, consistent: statusData.consistent ?? null }
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
    const client = clientFor(project);
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
    const client = clientFor(project);
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
        const page = renderPage({ token, projects: projectSummary(), defaultProject: options.defaultProject });
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

      if (request.method === 'GET' && url.pathname === '/api/overview') {
        await handleOverview(resolveProject(url.searchParams.get('project')), response);
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
