/**
 * 生成「更新器」发布包：用发布通道把 airlock 本体更新到服务器。
 *
 * 为什么需要它：部署账号被 `ForceCommand` 锁在 deployer 上时，agent 没有交互 shell，
 * 但 deployer 能以部署账号的身份起进程。于是发一个版本上去，让它的 `start` 先覆盖服务器
 * 上的 airlock 安装目录，再起 HTTP 服务让健康检查通过。原理与实测见 docs/TRANSFER.md 4.2。
 *
 * 用法：
 *   node scripts/build-updater.mjs --out .\updater
 *   node scripts/build-updater.mjs --out .\updater --target C:/airlock --port 3080
 *   node scripts/build-updater.mjs --out .\updater --preserve qingmang:data,assets/img/uploads
 *
 * 然后发布（`<沙盒应用>` 是部署器里那个 start 会执行版本目录里 node 入口的应用）：
 *   node bin/airlock-deploy.mjs release --app demo --server srv-prod02 `
 *       --source .\updater --version v0.6.1-update
 *
 * payload 只带 bin/、src/、package.json、package-lock.json：服务器上的 config/、
 * node_modules/ 与本地脚本原样保留。依赖有变化时不能用它，见 docs/TRANSFER.md 第 5 节。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const out = resolve(arg('out', 'updater'));
const target = arg('target', 'C:/airlock');
const port = Number(arg('port', '3080'));
const preserve = [];
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--preserve') continue;
  const raw = process.argv[i + 1] ?? '';
  const split = raw.indexOf(':');
  if (split === -1) throw new Error(`--preserve 要写成 <应用id>:<路径1>,<路径2>，收到：${raw}`);
  const paths = raw.slice(split + 1).split(',').map(item => item.trim()).filter(Boolean);
  if (paths.length === 0) throw new Error(`--preserve 的路径不能为空：${raw}`);
  preserve.push({ app: raw.slice(0, split).trim(), paths });
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不合法：${arg('port', '')}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// payload：只带代码与清单，服务器上的 config/、node_modules/ 不能动
const payload = join(out, 'payload');
mkdirSync(payload, { recursive: true });
for (const item of ['bin', 'src']) cpSync(join(repo, item), join(payload, item), { recursive: true });
for (const item of ['package.json', 'package-lock.json']) cpSync(join(repo, item), join(payload, item));

const template = `#!/usr/bin/env node
/**
 * 一次性更新器（由 airlock scripts/build-updater.mjs 生成，勿手改）。
 *
 * 顺序很重要：先覆盖代码，再起服务。覆盖失败时服务也要起来——否则健康检查失败会触发
 * 自动回退，旧版本的更新器又跑一遍，把刚落地的代码覆盖回去。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = __TARGET__;
const PORT = __PORT__;
const VERSION = __VERSION__;
const PRESERVE = __PRESERVE__;

const notes = [];
const stats = { files: 0 };

// 落地标记：更新器只有被 start 真正执行才会写它。健康检查失败时，靠这几个文件判断
// 「start 没跑 node 入口」还是「跑了但服务没起来」——deployer 没有读文件的 op。
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const diag = ['version=' + VERSION, 'stamp=' + stamp, 'cwd=' + process.cwd(),
  'here=' + HERE, 'target=' + TARGET, 'port=' + PORT].join('\\n') + '\\n';
for (const dir of [process.env.TEMP, process.env.USERPROFILE, TARGET]) {
  if (!dir) continue;
  try { writeFileSync(join(dir, 'airlock-updater.log'), diag, 'utf8'); } catch { /* 写不了就算了 */ }
}

function overlay(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) overlay(src, dst);
    else { copyFileSync(src, dst); stats.files += 1; }
  }
}

function readConfig(configPath) {
  return JSON.parse(readFileSync(configPath, 'utf8').replace(/^\\uFEFF/, ''));
}

/** 只加 preservePaths；同路径若还在 sharedPaths 里就移除（都配等于没配，链接照建）。 */
function patchOne(entry) {
  const configPath = join(TARGET, 'config', 'deployer.json');
  if (!existsSync(configPath)) { notes.push('跳过 ' + entry.app + '：没有 ' + configPath); return; }
  const config = readConfig(configPath);
  const app = config.apps && config.apps[entry.app];
  if (!app) { notes.push('跳过 ' + entry.app + '：配置里没有这个应用'); return; }

  const shared = Array.isArray(app.sharedPaths) ? app.sharedPaths : [];
  const moved = entry.paths.filter(path => shared.includes(path));
  if (moved.length > 0) {
    app.sharedPaths = shared.filter(path => !moved.includes(path));
    if (app.sharedPaths.length === 0) delete app.sharedPaths;
    notes.push(entry.app + '：从 sharedPaths 移除 ' + moved.join('、'));
    if (Array.isArray(app.backupPaths) && app.backupPaths.includes('shared')) {
      notes.push(entry.app + '：backupPaths 仍含 shared——数据已经不在那里，备份会变空，记得复核');
    }
  }

  const existing = Array.isArray(app.preservePaths) ? app.preservePaths : [];
  app.preservePaths = [...new Set([...existing, ...entry.paths])];
  const backupPath = configPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(configPath, backupPath);
  const tmp = configPath + '.tmp-updater';
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\\n', 'utf8');
  renameSync(tmp, configPath);
  notes.push(entry.app + '：preservePaths = ' + app.preservePaths.join('、') + '（备份 ' + backupPath + '）');
}

let overlaid = false;
try {
  overlay(join(HERE, 'payload'), TARGET);
  overlaid = true;
  notes.push('覆盖 ' + stats.files + ' 个文件到 ' + TARGET);
} catch (error) {
  notes.push('覆盖失败：' + (error && error.message ? error.message : String(error)));
}
// 代码没覆盖成功就不能动配置：旧 deployer 不认识新字段，会把整份配置拒掉。
for (const entry of PRESERVE) {
  if (!overlaid) { notes.push('跳过配置补丁：代码没有覆盖成功'); break; }
  try { patchOne(entry); } catch (error) {
    notes.push(entry.app + ' 配置补丁失败：' + (error && error.message ? error.message : String(error)));
  }
}
try {
  writeFileSync(join(TARGET, 'update-applied.txt'),
    'v' + VERSION + '  ' + new Date().toISOString() + '\\n' + notes.map(line => '  ' + line).join('\\n') + '\\n', 'utf8');
} catch { /* 写不了也不影响更新 */ }
for (const line of notes) console.log('[updater] ' + line);

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('airlock v' + VERSION + ' updated\\n' + notes.join('\\n') + '\\n');
});
server.on('error', error => {
  console.error('[updater] 服务起不来：' + error.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log('[updater] 健康检查已就绪：http://127.0.0.1:' + PORT));
`;

const content = template
  .replace('__TARGET__', JSON.stringify(target))
  .replace('__PORT__', String(port))
  .replace('__VERSION__', JSON.stringify(pkg.version))
  .replace('__PRESERVE__', JSON.stringify(preserve));

writeFileSync(join(out, 'server.mjs'), content, 'utf8');

// 入口名不止一种：不知道目标应用的 start 具体指向哪个文件，就把同一份脚本按常见入口名各放一份。
// 带 type:module 的 package.json 让 .js 也能走 ESM（没有它，index.js 会被当 CJS，import 直接报错）。
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'airlock-updater', 'private': true, type: 'module', version: `${pkg.version}-updater`,
}, null, 2) + '\n', 'utf8');
for (const entry of ['index.mjs', 'index.js', 'server.js', 'app.js', 'main.js']) {
  copyFileSync(join(out, 'server.mjs'), join(out, entry));
}

console.log(`已生成更新器：${out}`);
console.log(`  目标目录：${target}`);
console.log(`  健康检查端口：${port}`);
console.log(`  版本：v${pkg.version}`);
if (preserve.length > 0) console.log(`  配置补丁：${preserve.map(item => `${item.app}(${item.paths.join(',')})`).join('、')}`);
console.log('');
// --publish <应用id>@<服务器名>：生成完直接发，版本号带时间戳，省得撞 VERSION_EXISTS。
// 发布目标必须是「start 会执行版本目录里 node 入口」的沙盒应用，别指向线上站点。
const publish = arg('publish', null);
if (publish === null) {
  console.log('发布（<沙盒应用> 的 start 要执行版本目录里的 node 入口）：');
  console.log(`  node bin/airlock-deploy.mjs release --app demo --server srv-prod02 --source ${out} --version v${pkg.version}-update`);
  console.log('验证：升级后 status 返回里应出现 layout / sharedPaths / preservePaths 字段。');
} else {
  const [app, server] = publish.split('@');
  if (!app || !server) throw new Error(`--publish 要写成 <应用id>@<服务器名>，收到：${publish}`);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const version = `v${pkg.version}-${stamp}`;
  console.log(`开始发布：${app}@${server}，版本 ${version}`);
  const result = spawnSync(process.execPath, [
    join(repo, 'bin', 'airlock-deploy.mjs'), 'release',
    '--app', app, '--server', server, '--source', out, '--version', version,
  ], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
