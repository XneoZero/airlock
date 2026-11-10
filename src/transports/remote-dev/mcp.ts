/**
 * 独立的 MCP stdio 服务器：服务名 `airlock-remote-dev`。
 *
 * 与聊天工具面**完全分离**：开发通道的能力面是「读写服务器工作区」，
 * 把它注册进闲聊工具面会让模型在普通对话里获得改生产代码的能力。
 * 这里只暴露 10 个固定工具，逐个映射到 Broker 协议；不执行任意 shell、不拼命令。
 *
 * 协议只实现 initialize / tools/list / tools/call 与 ping 的最小集合：
 * 多实现的部分越多，越容易和宿主客户端的版本假设打架。
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { isAirlockError } from '../../contracts/errors.ts';
import type { RemoteDevClient } from './client.ts';

const SERVER_NAME = 'airlock-remote-dev';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2024-11-05';

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: Record<string, unknown>) => Promise<unknown>;
}

function needString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new Error(`缺少字符串参数：${key}`);
  return value;
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

function errorResult(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = isAirlockError(error) ? error.code : error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'INTERNAL';
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `执行失败（${code}）：${message}` }], isError: true };
}

function okResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return { content: [{ type: 'text', text: text === undefined ? 'null' : text }] };
}

function buildTools(client: RemoteDevClient): readonly McpTool[] {
  return [
    {
      name: 'remote_status', description: '服务器身份、工作区、版本与当前租约', inputSchema: objectSchema({}, []),
      run: () => client.status(),
    },
    {
      name: 'remote_list', description: '列出工作区文件（相对路径，受条目与深度上限约束）',
      inputSchema: objectSchema({ path: { type: 'string', description: '只列该相对目录/文件前缀' } }, []),
      run: args => client.list(typeof args.path === 'string' ? args.path : undefined),
    },
    {
      name: 'remote_read', description: '读取一个工作区文本文件（默认 256KB 上限）',
      inputSchema: objectSchema({ path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1 } }, ['path']),
      run: args => client.read(needString(args, 'path'), typeof args.maxBytes === 'number' ? args.maxBytes : undefined),
    },
    {
      name: 'remote_apply', description: '写入工作区文件：必须带 expectedHash 与 operationId，自动获取并释放租约',
      inputSchema: objectSchema({
        path: { type: 'string' }, expectedHash: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        operationId: { type: 'string' }, content: { type: 'string' },
        edits: { type: 'array', items: objectSchema({ oldText: { type: 'string' }, newText: { type: 'string' }, occurrence: { type: 'integer', minimum: 1 } }, ['oldText', 'newText']) },
        owner: { type: 'string', description: '租约持有者标识，默认 mcp' },
      }, ['path', 'expectedHash', 'operationId']),
      async run(args) {
        const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : 'mcp';
        await client.acquireLease(owner);
        try {
          return await client.apply(args);
        } finally {
          // 失败也要放租约：不放会让 CLI 与后续 MCP 调用全部 LEASE_CONFLICT。
          await client.releaseLease().catch(() => {});
        }
      },
    },
    {
      name: 'remote_git_status', description: 'git status --porcelain（非 git 仓库回明确错误）', inputSchema: objectSchema({}, []),
      run: () => client.gitStatus(),
    },
    {
      name: 'remote_git_diff', description: 'git diff（固定参数，输出有界）',
      inputSchema: objectSchema({ path: { type: 'string' }, stat: { type: 'boolean' } }, []),
      run: args => client.gitDiff({ ...(typeof args.path === 'string' ? { path: args.path } : {}), ...(args.stat === true ? { stat: true } : {}) }),
    },
    {
      name: 'remote_check', description: '启动一个预注册检查任务（不能指定命令）',
      inputSchema: objectSchema({ task: { type: 'string' } }, ['task']),
      run: args => client.check(needString(args, 'task')),
    },
    {
      name: 'remote_job_status', description: '查询检查任务状态与输出',
      inputSchema: objectSchema({ jobId: { type: 'string' } }, ['jobId']),
      run: args => client.jobStatus(needString(args, 'jobId')),
    },
    {
      name: 'remote_job_cancel', description: '取消一个运行中的检查任务',
      inputSchema: objectSchema({ jobId: { type: 'string' } }, ['jobId']),
      run: args => client.jobCancel(needString(args, 'jobId')),
    },
    {
      name: 'remote_release_request', description: '提交发布申请：冻结内容摘要与检查记录，同 releaseId 幂等',
      inputSchema: objectSchema({
        requestedBy: { type: 'string' },
        checks: { type: 'array', items: { type: 'object' } },
        migration: { type: 'object' },
        rollback: { type: 'object' },
      }, ['requestedBy', 'checks']),
      run: args => client.releaseRequest(args),
    },
  ];
}

export interface RemoteDevMcpOptions {
  readonly client: RemoteDevClient;
  readonly input: Readable;
  readonly output: Writable;
  readonly version?: string;
}

export interface RemoteDevMcpServer {
  readonly toolNames: readonly string[];
  close(): void;
}

export function createRemoteDevMcpServer(options: RemoteDevMcpOptions): RemoteDevMcpServer {
  const tools = buildTools(options.client);
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
      // 工具失败按 MCP 约定回 isError 文本，让模型能在同一轮里改参数重试；不是信封错误。
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
    const isNotification = id === undefined || id === null;
    if (isNotification) return; // 通知一律不回应，回包会被客户端当成下一条请求的回复
    const params = typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params) ? (record.params as Record<string, unknown>) : {};
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: options.version ?? SERVER_VERSION },
        });
        return;
      case 'ping': reply(id, {}); return;
      case 'tools/list': reply(id, { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }); return;
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
      // 分发自身出错属于实现缺陷，仍要给请求方一个回复，不能静默。
      const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
      replyError(record.id ?? null, -32603, `服务端内部错误：${error instanceof Error ? error.message : String(error)}`);
    });
  });

  return {
    toolNames: tools.map(tool => tool.name),
    close(): void { lines.close(); options.client.close(); },
  };
}
