/**
 * 本机侧客户端：开一条 SSH，写一行 JSON（install 时后面再接归档字节），读一行响应。
 *
 * 一次连接只做一个 op：连接短命、失败可重试、服务器进程不会攒状态。
 * 代价是一次发布要开三条连接（install / activate），换来的是每一步都能单独重跑。
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { DEPLOY_PROTOCOL, deployResponseSchema, type DeployOp, type DeployProfile } from './contracts.ts';
import { DeployError } from './errors.ts';

export interface DeployCall {
  readonly op: DeployOp;
  readonly app?: string;
  readonly params?: Record<string, unknown>;
  /** install 专用：本机归档文件与字节数。 */
  readonly archive?: { readonly file: string; readonly size: number };
  readonly timeoutMs?: number;
}

export interface DeployClientOptions {
  readonly profile: DeployProfile;
  readonly timeoutMs?: number;
  readonly sshBinary?: string;
}

export interface DeployClient {
  call(call: DeployCall): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function sshArgs(profile: DeployProfile, binary: string): string[] {
  const hostKeyChecking = profile.hostKeyChecking ?? 'yes';
  const args = ['-T', '-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${hostKeyChecking}`, '-o', 'ServerAliveInterval=15'];
  if (profile.userKnownHostsFile !== undefined && profile.userKnownHostsFile !== '') {
    args.push('-o', `UserKnownHostsFile=${profile.userKnownHostsFile}`);
  }
  if (profile.identityFile !== undefined && profile.identityFile !== '') args.push('-i', profile.identityFile);
  if (profile.port !== undefined) args.push('-p', String(profile.port));
  const destination = profile.user !== undefined && profile.user !== '' ? `${profile.user}@${profile.host}` : profile.host;
  args.push(destination, profile.deployerCommand);
  return args;
}

export function createDeployClient(options: DeployClientOptions): DeployClient {
  const binary = options.sshBinary ?? 'ssh';
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 1;

  return {
    call(call: DeployCall): Promise<unknown> {
      const id = nextId;
      nextId += 1;
      const timeoutMs = Math.max(1_000, call.timeoutMs ?? defaultTimeout);
      const request = {
        v: DEPLOY_PROTOCOL,
        id,
        op: call.op,
        ...(call.app === undefined ? {} : { app: call.app }),
        ...(call.params === undefined ? {} : { params: call.params }),
        ...(call.archive === undefined ? {} : { archiveSize: call.archive.size }),
      };

      return new Promise<unknown>((resolve, reject) => {
        const child = spawn(binary, sshArgs(options.profile, binary), {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (error: Error | null, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.kill(); } catch { /* 已退出 */ }
          if (error === null) resolve(value);
          else reject(error);
        };

        const timer = setTimeout(() => {
          finish(new DeployError('INTERNAL', `请求超时：${call.op}（${timeoutMs}ms）`));
        }, timeoutMs);

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', (error: Error) => {
          finish(new DeployError('INTERNAL', `无法启动 ssh：${error.message}`));
        });

        child.on('close', (code: number | null) => {
          const firstLine = stdout.split(/\r?\n/).find(line => line.trim() !== '') ?? '';
          if (firstLine === '') {
            finish(new DeployError('INTERNAL', explainSshFailure(stderr, code)));
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(firstLine);
          } catch {
            finish(new DeployError('INTERNAL', `响应不是合法 JSON：${firstLine.slice(0, 200)}`));
            return;
          }
          const parsed = deployResponseSchema.safeParse(raw);
          if (!parsed.success) {
            finish(new DeployError('INTERNAL', '响应不符合部署契约'));
            return;
          }
          const response = parsed.data;
          if (response.ok) {
            finish(null, response.data);
            return;
          }
          const error = response.error;
          finish(new DeployError(error?.code ?? 'INTERNAL', error?.message ?? '发布失败', error?.detail));
        });

        child.stdin?.on('error', () => { /* 对端提前关闭时由 close 事件统一报错 */ });
        child.stdin?.write(`${JSON.stringify(request)}\n`);

        if (call.archive === undefined) {
          child.stdin?.end();
          return;
        }
        const stream = createReadStream(call.archive.file);
        stream.on('error', (error: Error) => finish(new DeployError('INTERNAL', `读取归档失败：${error.message}`)));
        stream.on('data', (chunk: string | Buffer) => {
          if (!child.stdin?.writable) return;
          child.stdin.write(chunk);
        });
        stream.on('end', () => { child.stdin?.end(); });
      });
    },
  };
}

/**
 * 把 ssh 的 stderr 归成「下一步查什么」，而不是把原始文本丢给用户。
 *
 * 这几条都是真机接入时最常撞到的，每一条的处理办法完全不同；混成一句
 * 「部署器没有返回响应」只会让人去翻 sshd 日志。
 */
export function explainSshFailure(stderr: string, code: number | null): string {
  const base = `部署器没有返回响应（ssh 退出码 ${code ?? '?'}）`;
  const text = stderr.toLowerCase();
  if (text.includes('connection refused')) {
    return `${base}：22 端口没有监听——sshd 没启动，或者改了端口`;
  }
  if (text.includes('connection timed out') || text.includes('operation timed out')) {
    return `${base}：连接超时——云安全组或防火墙没放行 22，这一步只有机器主人能做`;
  }
  if (text.includes('permission denied')) {
    return `${base}：认证被拒——密钥、账号所在组（AllowGroups）、ForceCommand 三者之一没配好；看服务器 sshd 日志`;
  }
  if (text.includes('host key verification failed') || text.includes('remote host identification has changed')) {
    return `${base}：主机键变了（机器重装过）——先 ssh-keygen -R <主机> 再试`;
  }
  if (text.includes('could not resolve hostname')) {
    return `${base}：主机名解析不了——检查 host 拼写或 DNS`;
  }
  const hint = stderr.trim().split(/\r?\n/).slice(0, 3).join(' / ');
  return hint === '' ? base : `${base}：${hint}`;
}