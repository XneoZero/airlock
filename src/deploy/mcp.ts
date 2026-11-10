/**
 * 发布通道的 MCP 工具面：模型能"发布/回滚/查状态"，但不能指定命令、路径或服务名。
 * 与 remote-dev 的 MCP 是两套服务（airlock-remote-dev / airlock-deploy），互不注册。
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { DeployClient } from './client.ts';
import { packRelease } from './local.ts';

const SERVER_NAME = 'airlock-deploy';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2024-11-05';

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: Record<string, unknown>) => Promise<unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

function needString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new Error(`缺少字符串参数：${key}`);
  return value;
}

function okResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return { content: [{ type: 'text', text }] };
}

function errorResult(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'INTERNAL';
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `发布失败（${code}）：${message}` }], isError: true };
}

export interface DeployMcpOptions {
  readonly client: DeployClient;
  readonly input: Readable;
  readonly output: Writable;
  /** 打包默认目录：档案里的 workspace 或当前目录。 */
  readonly sourceDir: string;
  readonly defaultApp?: string;
  readonly version?: string;
}

function buildTools(options: DeployMcpOptions): readonly Tool[] {
  const appArg = { type: 'string', description: '应用 id；配置里只有一个应用时可省略' };
  return [
    {
      name: 'deploy_status',
      description: '查看服务器上应用的当前版本、历史记录与健康状态',
      inputSchema: objectSchema({ app: appArg, probe: { type: 'boolean', description: '是否现场探活' } }),
      run: args => options.client.call({
        op: 'status',
        ...(typeof args.app === 'string' ? { app: args.app } : {}),
        params: args.probe === true ? { probe: true } : {},
      }),
    },
    {
      name: 'deploy_list_versions',
      description: '列出已安装的版本（含未激活的）',
      inputSchema: objectSchema({ app: appArg }),
      run: args => options.client.call({ op: 'list', app: typeof args.app === 'string' ? args.app : options.defaultApp }),
    },
    {
      name: 'deploy_release',
      description: '把本地已构建好的目录打包发布到服务器：上传 → 解压校验 → 切换版本 → 重启 → 健康检查',
      inputSchema: objectSchema({
        app: appArg,
        sourceDir: { type: 'string', description: '本地目录；缺省用档案里的 workspace' },
        version: { type: 'string', description: '版本号；缺省按时间戳与 git 提交生成' },
        exclude: { type: 'array', items: { type: 'string' }, description: '额外排除的目录名' },
      }, []),
      async run(args) {
        const app = typeof args.app === 'string' && args.app !== '' ? args.app : options.defaultApp;
        const sourceDir = typeof args.sourceDir === 'string' && args.sourceDir !== '' ? args.sourceDir : options.sourceDir;
        const packed = await packRelease({
          sourceDir,
          ...(typeof args.version === 'string' && args.version !== '' ? { version: args.version } : {}),
          ...(Array.isArray(args.exclude) ? { exclude: args.exclude.filter((item): item is string => typeof item === 'string') } : {}),
        });
        try {
          const installed = await options.client.call({
            op: 'install',
            ...(app === undefined ? {} : { app }),
            params: { version: packed.version, manifestHash: packed.manifest.totalHash, commit: packed.commit },
            archive: { file: packed.archive, size: packed.bytes },
            timeoutMs: 20 * 60_000,
          });
          const activated = await options.client.call({
            op: 'activate',
            ...(app === undefined ? {} : { app }),
            params: { version: packed.version },
            timeoutMs: 20 * 60_000,
          });
          return { version: packed.version, manifestHash: packed.manifest.totalHash, installed, activated };
        } finally {
          await packed.cleanup();
        }
      },
    },
    {
      name: 'deploy_rollback',
      description: '回滚到上一个已部署版本（或指定版本），可选连数据备份一起恢复',
      inputSchema: objectSchema({
        app: appArg,
        to: { type: 'string', description: '目标版本；缺省回滚到上一个已部署版本' },
        restoreBackup: { type: 'boolean', description: '是否同时恢复该版本的发布前数据备份' },
      }),
      run: args => options.client.call({
        op: 'rollback',
        ...(typeof args.app === 'string' ? { app: args.app } : {}),
        params: {
          ...(typeof args.to === 'string' && args.to !== '' ? { to: args.to } : {}),
          ...(args.restoreBackup === true ? { restoreBackup: true } : {}),
        },
        timeoutMs: 10 * 60_000,
      }),
    },
    {
      name: 'deploy_logs',
      description: '查看某个应用最近的发布日志与进程状态',
      inputSchema: objectSchema({ app: appArg, lines: { type: 'integer', minimum: 1, maximum: 500 } }),
      run: args => options.client.call({
        op: 'logs',
        ...(typeof args.app === 'string' ? { app: args.app } : {}),
        params: typeof args.lines === 'number' ? { lines: args.lines } : {},
      }),
    },
  ];
}

export interface DeployMcpServer {
  readonly toolNames: readonly string[];
  close(): void;
}

export function createDeployMcpServer(options: DeployMcpOptions): DeployMcpServer {
  const tools = buildTools(options);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const send = (message: unknown): void => { options.output.write(`${JSON.stringify(message)}\n`); };
  const reply = (id: unknown, result: unknown): void => send({ jsonrpc: '2.0', id, result });
  const replyError = (id: unknown, code: number, message: string): void => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function callTool(id: unknown, params: Record<string, unknown>): Promise<void> {
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      replyError(id, -32602, 'tools/call 缺少工具名 name');
      return;
    }
    const tool = byName.get(name);
    if (tool === undefined) {
      replyError(id, -32602, `未知工具：${name}`);
      return;
    }
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      replyError(id, -32602, 'tools/call 的 arguments 必须是对象');
      return;
    }
    try {
      reply(id, okResult(await tool.run(args as Record<string, unknown>)));
    } catch (error) {
      reply(id, errorResult(error));
    }
  }

  async function dispatch(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    const id = record.id;
    const method = record.method;
    if (typeof method !== 'string') {
      if (id !== undefined && id !== null) replyError(id, -32600, '缺少 method');
      return;
    }
    if (id === undefined || id === null) return;
    const params = typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>) : {};
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: options.version ?? SERVER_VERSION },
        });
        return;
      case 'ping': reply(id, {}); return;
      case 'tools/list':
        reply(id, { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
        return;
      case 'tools/call': await callTool(id, params); return;
      default: replyError(id, -32601, `未知方法：${method}`);
    }
  }

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  lines.on('line', (line: string) => {
    const text = line.trim();
    if (text === '') return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      replyError(null, -32700, '不是合法的 JSON 行');
      return;
    }
    void dispatch(message).catch((error: unknown) => {
      const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
      replyError(record.id ?? null, -32603, `服务端内部错误：${error instanceof Error ? error.message : String(error)}`);
    });
  });

  return { toolNames: tools.map(tool => tool.name), close(): void { lines.close(); } };
}
