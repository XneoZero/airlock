/**
 * 控制台单页。没有构建步骤、没有依赖：一个 HTML 字符串，CSS 与 JS 内联。
 *
 * 注意：内联 JS 里刻意不用模板字符串（反引号），否则会和本文件外层的模板字符串打架。
 */
export interface PageProject {
  readonly name: string;
  readonly app: string;
  readonly workspace: string;
  readonly serverId: string | null;
  readonly host: string;
  /** 档案里这个项目默认指向的服务器名（内联连接信息时为 null）。 */
  readonly serverName: string | null;
}

export interface PageOptions {
  readonly token: string;
  readonly projects: readonly PageProject[];
  readonly defaultProject: string;
  /** 本机 Airlock 安装目录（包根，不是 cwd），写进「接入新服务器」的提示词。 */
  readonly airlockRoot: string;
  /** 实际生效的档案文件绝对路径；档案来自环境变量时为空。 */
  readonly profilesFile: string;
  /** 运行控制台的操作系统（process.platform），提示词要按它区分 Windows / macOS / Linux。 */
  readonly platform: string;
}

export function renderPage(options: PageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Airlock 发布控制台</title>
<style>
  :root{
    --bg:#0f1115; --panel:#161a22; --line:#262c38; --text:#d7dce6; --dim:#8b93a7;
    --accent:#4f8cff; --ok:#3fb950; --warn:#d29922; --bad:#f85149;
    --mono:'JetBrains Mono','Cascadia Code',Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:14px/1.5 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}
  header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
         padding:14px 20px;background:rgba(15,17,21,.92);border-bottom:1px solid var(--line);
         backdrop-filter:blur(8px)}
  h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.3px}
  h1 b{color:var(--accent);font-weight:600}
  .meta{display:flex;gap:14px;font-family:var(--mono);font-size:12px;color:var(--dim)}
  .meta span b{color:var(--text);font-weight:500}
  .meta span b.copyable{cursor:pointer;border-bottom:1px dashed var(--dim);display:inline-block;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
  .meta .mini{padding:1px 7px;margin-left:6px;font-size:11px;border-radius:5px;vertical-align:middle}
  .spacer{flex:1}
  button{font:inherit;padding:7px 14px;border-radius:7px;border:1px solid var(--line);
         background:#1c222d;color:var(--text);cursor:pointer;transition:.15s}
  button:hover{border-color:#3a4356;background:#222a36}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover{background:#3f7ef0}
  button.danger{color:var(--bad);border-color:#4a2020}
  button.danger:hover{background:#2a1618;border-color:var(--bad)}
  select{padding:7px 10px;border-radius:7px;border:1px solid var(--line);background:#1c222d;
         color:var(--text);font:inherit;max-width:260px}
  select:hover{border-color:#3a4356}
  main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 20px}
  @media(max-width:900px){main{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;
         display:flex;flex-direction:column;min-height:320px}
  .panel h2{margin:0;padding:11px 16px;font-size:12px;font-weight:600;letter-spacing:.6px;
            text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line)}
  .scroll{overflow:auto;flex:1;max-height:46vh}
  ul.git{list-style:none;margin:0;padding:8px 0}
  ul.git li{padding:7px 16px;border-bottom:1px solid rgba(38,44,56,.5);display:grid;
            grid-template-columns:64px 1fr;gap:10px;align-items:baseline}
  ul.git li:last-child{border-bottom:0}
  ul.git .h{font-family:var(--mono);font-size:12px;color:var(--accent)}
  ul.git .s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  ul.git .d{font-size:11px;color:var(--dim);margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{position:sticky;top:0;background:var(--panel);text-align:left;padding:8px 12px;
     font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);
     border-bottom:1px solid var(--line);font-weight:600}
  td{padding:8px 12px;border-bottom:1px solid rgba(38,44,56,.5);vertical-align:middle}
  tr.current{background:rgba(79,140,255,.08)}
  tr.current td:first-child{border-left:2px solid var(--accent)}
  .v{font-family:var(--mono);font-size:12.5px}
  .badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;font-weight:600}
  .badge.deployed{background:rgba(63,185,80,.15);color:var(--ok)}
  .badge.failed{background:rgba(248,81,73,.15);color:var(--bad)}
  .badge.rolled_back{background:rgba(210,153,34,.15);color:var(--warn)}
  .badge.installed{background:rgba(139,147,167,.15);color:var(--dim)}
  .badge.unknown{background:rgba(139,147,167,.1);color:var(--dim)}
  .row-actions{text-align:right}
  .row-actions button{padding:3px 9px;font-size:12px}
  footer{margin:0 20px 20px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
  footer h2{margin:0;padding:11px 16px;font-size:12px;text-transform:uppercase;letter-spacing:.6px;
            color:var(--dim);border-bottom:1px solid var(--line);font-weight:600}
  pre.log{margin:0;padding:12px 16px;font-family:var(--mono);font-size:12px;color:var(--dim);
          max-height:190px;overflow:auto;white-space:pre-wrap;word-break:break-all}
  .empty{padding:28px 16px;text-align:center;color:var(--dim);font-size:13px}
  dialog{border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);
         padding:0;width:min(460px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.5)}
  dialog::backdrop{background:rgba(0,0,0,.55)}
  dialog .body{padding:18px}
  dialog h3{margin:0 0 14px;font-size:15px;font-weight:600}
  dialog label{display:block;font-size:12px;color:var(--dim);margin:12px 0 5px}
  dialog input{width:100%;padding:8px 10px;border-radius:7px;border:1px solid var(--line);
               background:#0f1115;color:var(--text);font-family:var(--mono);font-size:12.5px}
  dialog .foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;
               border-top:1px solid var(--line)}
  .hint{font-size:11.5px;color:var(--dim);margin-top:6px}
  .places{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
  .places button{padding:5px 10px;font-size:12px;border-radius:6px}
  .dirlist{margin-top:10px;max-height:44vh;overflow:auto;border:1px solid var(--line);border-radius:8px;background:#12161d}
  .dirlist .row{display:flex;align-items:center;gap:8px;padding:6px 11px;cursor:pointer;
                font-family:var(--mono);font-size:12px;border-bottom:1px solid rgba(255,255,255,.03)}
  .dirlist .row:hover{background:rgba(255,255,255,.055)}
  .dirlist .row .ico{width:12px;flex:none;color:var(--dim)}
  .dirlist .row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dirlist .empty{padding:16px;text-align:center;color:var(--dim);font-size:12px}
  #toast{position:fixed;right:20px;bottom:20px;max-width:420px;padding:12px 16px;border-radius:9px;
         background:#1c222d;border:1px solid var(--line);font-size:13px;opacity:0;
         transform:translateY(8px);transition:.2s;pointer-events:none;z-index:20;white-space:pre-wrap}
  #toast.show{opacity:1;transform:none}
  #toast.ok{border-color:rgba(63,185,80,.5)}
  #toast.err{border-color:rgba(248,81,73,.5)}
  .skel{height:14px;background:linear-gradient(90deg,#1b2029,#232a36,#1b2029);
        background-size:200% 100%;animation:sh 1.2s infinite;border-radius:4px;margin:10px 16px}
  @keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
  #drop-veil{position:fixed;inset:0;display:none;place-items:center;z-index:30;
             background:rgba(15,17,21,.86);border:2px dashed var(--accent);
             color:var(--accent);font-size:18px;font-weight:600}
  #drop-veil.show{display:grid}
  .banner{display:none;margin:0 20px 14px;padding:10px 14px;border-radius:8px;font-size:13px;
          background:rgba(255,186,80,.10);border:1px solid rgba(255,186,80,.35);color:var(--text)}
  .banner.show{display:flex;gap:12px;align-items:center;justify-content:space-between}
  .banner button{padding:4px 10px;font-size:12px;border-radius:6px;flex:none}
  dialog textarea{width:100%;min-height:220px;padding:10px;border-radius:7px;border:1px solid var(--line);
                  background:#12161d;color:var(--text);font-family:var(--mono);font-size:12px;
                  line-height:1.5;resize:vertical}
  .row2{display:flex;gap:8px}
  .row2 select{flex:1}
  dl.kv{display:grid;grid-template-columns:86px 1fr;gap:7px 14px;margin:12px 0 0;font-size:12.5px}
  dl.kv dt{color:var(--dim);white-space:nowrap}
  dl.kv dd{margin:0;font-family:var(--mono);word-break:break-all}
</style>
</head>
<body>
<header>
  <h1>Airlock <b>·</b> <span id="app-name">—</span></h1>
  <select id="project-select" title="切换项目"></select>
  <select id="server-select" title="部署到哪台服务器"></select>
  <div class="meta">
    <span>服务器 <b id="server">—</b></span>
    <span>系统 <b id="os" class="copyable" title="点击查看操作系统详情">—</b></span>
    <span>落点 <b id="root" class="copyable" title="点击复制服务器上的目录">—</b><button type="button" id="btn-root" class="mini" title="改服务器上的发布目录">改</button></span>
    <span>当前版本 <b id="current">—</b></span>
    <span>一致性 <b id="consistent">—</b></span>
    <span>本地改动 <b id="dirty">—</b></span>
  </div>
  <div class="spacer"></div>
  <button id="btn-add">＋ 项目</button>
  <button id="btn-join" title="接一台新服务器">＋ 服务器</button>
  <button id="btn-refresh">刷新</button>
  <button id="btn-release" class="primary">发布新版本</button>
</header>

<div id="banner" class="banner">
  <span id="banner-text"></span>
  <button type="button" id="banner-action">让 agent 搭一台</button>
</div>

<main>
  <section class="panel">
    <h2>本地更改记录</h2>
    <div class="scroll" id="git-panel"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>
  </section>
  <section class="panel">
    <h2>服务器版本</h2>
    <div class="scroll" id="rel-panel"><div class="skel"></div><div class="skel"></div></div>
  </section>
</main>

<footer>
  <h2>部署日志</h2>
  <pre class="log" id="log">加载中…</pre>
</footer>

<dialog id="dlg">
  <form method="dialog" id="form">
    <div class="body">
      <h3>发布新版本</h3>
      <label>发布哪个目录</label>
      <select id="in-source-select"></select>
      <div id="in-source-row" style="display:none;gap:8px;margin-top:8px">
        <input id="in-source" spellcheck="false" style="flex:1;width:auto" placeholder="输入绝对路径，或点「选择文件夹…」">
        <button type="button" id="btn-source-browse">选择文件夹…</button>
      </div>
      <div class="hint" id="source-hint">自动探测到的构建产物目录</div>
      <label>版本号（可选）</label>
      <input id="in-version" placeholder="留空按时间戳 + git 提交生成" spellcheck="false">
    </div>
    <div class="foot">
      <button value="cancel" formnovalidate>取消</button>
      <button type="button" class="primary" id="btn-confirm">开始发布</button>
    </div>
  </form>
</dialog>

<div id="toast"></div>

<dialog id="add-dlg">
  <form method="dialog" id="add-form">
    <div class="body">
      <h3>添加项目</h3>
      <label>项目目录</label>
      <div style="display:flex;gap:8px">
        <input id="add-path" spellcheck="false" placeholder="点「选择文件夹」用系统窗口选，或把文件夹拖进窗口" style="flex:1;width:auto">
        <button type="button" id="add-browse">选择文件夹…</button>
      </div>
      <input type="file" id="add-picker" webkitdirectory directory multiple style="display:none">
      <div class="hint" id="add-path-hint">默认打开系统文件夹窗口；浏览器只给文件夹名，选完会自动在常用位置找完整路径</div>
      <label>项目名</label>
      <input id="add-name" placeholder="例如 my-web" spellcheck="false">
      <label>服务器上的应用 id</label>
      <input id="add-app" placeholder="例如 web（deployer.json 里的 key）" spellcheck="false">
      <div class="hint">新项目继承当前项目的服务器连接（host / 用户 / 密钥）</div>
    </div>
    <div class="foot">
      <button value="cancel" formnovalidate>取消</button>
      <button type="button" class="primary" id="add-confirm">添加</button>
    </div>
  </form>
</dialog>

<dialog id="browse-dlg">
  <div class="body">
    <h3>选择服务器上的目录</h3>
    <div class="places" id="browse-places"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button type="button" id="browse-up" title="上一级">↑</button>
      <input id="browse-path" spellcheck="false" style="flex:1;width:auto;font-family:var(--mono);font-size:12px">
      <button type="button" id="browse-go">转到</button>
    </div>
    <div class="dirlist" id="browse-list"></div>
    <div class="hint">单击进入子目录，「用这个目录」选中当前所在目录</div>
  </div>
  <div class="foot">
    <button type="button" id="browse-cancel">取消</button>
    <button type="button" class="primary" id="browse-ok">用这个目录</button>
  </div>
</dialog>

<dialog id="join-dlg">
  <div class="body">
    <h3>接一台新服务器</h3>
    <div class="hint" style="margin-top:0">
      新机器上要装 Node、建部署账号、改 sshd——交给 agent 做最省事。
      填地址和系统，下面这段直接复制给它，它会按标准流程接完。
    </div>
    <div class="row2" style="margin-top:12px">
      <input id="join-host" spellcheck="false" placeholder="目标机器 IP 或域名，例如 1.2.3.4">
      <select id="join-platform">
        <option value="windows">Windows</option>
        <option value="linux">Linux</option>
      </select>
    </div>
    <label>复制这段给 agent</label>
    <textarea id="join-prompt" readonly></textarea>
    <div class="hint">接完它会告诉你服务器名字、应用 id 和落点路径，填进「＋ 服务器」就能用。</div>
  </div>
  <div class="foot">
    <button type="button" id="join-cancel">关闭</button>
    <button type="button" class="primary" id="join-copy">复制提示词</button>
  </div>
</dialog>

<div id="drop-veil">松开以添加这个文件夹</div>

<dialog id="os-dlg">
  <div class="body">
    <h3>服务器操作系统</h3>
    <dl class="kv" id="os-body"></dl>
    <div class="hint" id="os-hint"></div>
  </div>
  <div class="foot">
    <button type="button" class="primary" id="os-close">关闭</button>
  </div>
</dialog>

<script>
(function(){
  'use strict';
  var TOKEN = new URLSearchParams(location.search).get('t') || '';
  var PROJECTS = ${JSON.stringify(options.projects)};
  var currentProject = ${JSON.stringify(options.defaultProject)};
  var currentServer = '';
  var AIRLOCK_ROOT = ${JSON.stringify(options.airlockRoot)};
  var PROFILES_FILE = ${JSON.stringify(options.profilesFile)};
  var PLATFORM = ${JSON.stringify(options.platform)};
  // 路径分隔符按平台来：提示词里的命令要能直接在用户自己的机器上跑。
  var SEP = PLATFORM === 'win32' ? String.fromCharCode(92) : '/';
  var HOST_OS = PLATFORM === 'win32' ? 'Windows' : (PLATFORM === 'darwin' ? 'macOS' : 'Linux');
  var APP = '';
  var busy = false;
  var overviewData = null;

  // ---- 选择记忆：下次打开回到上次的项目与服务器 ----
  var STORE_PROJECT = 'airlock.project';
  var STORE_SERVER = 'airlock.server';

  function recall(key){
    try { return localStorage.getItem(key) || ''; } catch (error) { return ''; }
  }
  function remember(key, value){
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (error) { /* 隐私模式下写不了，忽略 */ }
  }
  function projectDefaultServer(name){
    for (var i = 0; i < PROJECTS.length; i++){
      if (PROJECTS[i].name === name) return PROJECTS[i].serverName || '';
    }
    return '';
  }

  (function restoreSelection(){
    var savedProject = recall(STORE_PROJECT);
    for (var i = 0; i < PROJECTS.length; i++){
      if (PROJECTS[i].name === savedProject){ currentProject = savedProject; break; }
    }
    // 服务器记忆可能指向已删除的机器，先按项目默认走；真失效了 load 里会退回。
    currentServer = recall(STORE_SERVER) || projectDefaultServer(currentProject);
  })();

  function q(id){ return document.getElementById(id); }

  function toast(text, kind){
    var el = q('toast');
    el.textContent = text;
    el.className = 'show ' + (kind || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function(){ el.className = ''; }, kind === 'err' ? 8000 : 4000);
  }

  function api(path, options){
    options = options || {};
    options.headers = Object.assign({ 'x-airlock-token': TOKEN }, options.headers || {});
    return fetch(path, options).then(function(r){
      return r.json().then(function(body){ return { status: r.status, body: body }; });
    });
  }

  function fmtTime(value){
    if (typeof value !== 'number' || value <= 0) return '—';
    var d = new Date(value);
    var p = function(n){ return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function badge(status){
    var label = { deployed:'已部署', failed:'失败', rolled_back:'已回滚', installed:'已安装', unknown:'未知' }[status] || status;
    return '<span class="badge ' + status + '">' + label + '</span>';
  }

  function renderGit(list, status){
    var panel = q('git-panel');
    if (!list.length){
      panel.innerHTML = '<div class="empty">不是 git 仓库，或读不到提交记录</div>';
      return;
    }
    var html = '<ul class="git">';
    for (var i = 0; i < list.length; i++){
      var c = list[i];
      html += '<li><div class="h">' + c.hash + '</div><div>' +
              '<div class="s">' + escapeHtml(c.subject) + '</div>' +
              '<div class="d">' + escapeHtml(c.author) + ' · ' + escapeHtml(c.date) + '</div>' +
              '</div></li>';
    }
    html += '</ul>';
    if (status && status.clean === false){
      html = '<div style="padding:8px 16px;font-size:12px;color:var(--warn)">有 ' + status.dirty + ' 个未提交改动</div>' + html;
    }
    panel.innerHTML = html;
  }

  function renderReleases(data){
    var panel = q('rel-panel');
    var list = data.releases || [];
    if (!list.length){
      panel.innerHTML = '<div class="empty">服务器上还没有版本</div>';
      return;
    }
    list = list.slice().reverse();
    var html = '<table><thead><tr><th>版本</th><th>状态</th><th>时间</th><th class="row-actions">操作</th></tr></thead><tbody>';
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      var cls = r.current ? ' class="current"' : '';
      html += '<tr' + cls + '>' +
        '<td class="v">' + escapeHtml(r.version) + (r.current ? ' <span style="color:var(--accent);font-size:11px">当前</span>' : '') + '</td>' +
        '<td>' + badge(r.status) + '</td>' +
        '<td class="v" style="font-size:11.5px;color:var(--dim)">' + fmtTime(r.activatedAt || r.createdAt) + '</td>' +
        '<td class="row-actions">' +
          (r.current ? '' : '<button class="danger" data-rollback="' + escapeHtml(r.version) + '">回退到此版本</button>') +
        '</td></tr>';
    }
    html += '</tbody></table>';
    panel.innerHTML = html;
  }

  function escapeHtml(value){
    return String(value).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  function load(){
    q('btn-refresh').disabled = true;
    q('btn-refresh').textContent = '刷新中…';
    api('/api/overview?project=' + encodeURIComponent(currentProject)
        + (currentServer ? '&server=' + encodeURIComponent(currentServer) : ''))
      .then(function(res){
        if (res.status !== 200){ throw new Error(res.body.error ? res.body.error.message : '读取失败'); }
        var d = res.body;
        overviewData = d;
        APP = d.app || '';
        if (d.projects && d.projects.length) rebuildProjectSelect(d.projects, d.serverApps);
        rebuildServerSelect(d.servers || [], currentServer);
        q('project-select').title = d.profilesExplicit
          ? '档案只读 ' + (d.profilesFile || '指定的那一份') + '（--profiles 或环境变量），项目内 config 未参与合并'
          : '切换项目';
        if (d.reloadError){
          toast('档案读取失败，仍在用启动时那份：' + d.reloadError, 'err');
        }
        q('app-name').textContent = d.app;
        q('server').textContent = d.server && d.server.serverId ? d.server.serverId : '不可达';
        var osInfo = d.server && d.server.os ? d.server.os : null;
        var osFallback = d.server && d.server.kind === 'windows' ? 'Windows'
          : (d.server && d.server.kind === 'linux' ? 'Linux' : '—');
        q('os').textContent = osInfo && osInfo.name ? osInfo.name : osFallback;
        q('os').title = osInfo
          ? '点击查看操作系统详情'
          : '拿不到详情：服务器不可达，或服务器上的部署器还不支持 sysinfo';
        q('root').textContent = d.server && d.server.root ? d.server.root : '—';
        q('root').title = d.server && d.server.root
          ? '点击复制。releases/版本/ 放代码，current 指向在用版本，backups/ 放数据快照'
          : '服务器不可达';
        q('current').textContent = d.server && d.server.current ? d.server.current : '无';
        q('consistent').textContent = d.server && d.server.consistent === true ? '正常' : '不一致';
        q('consistent').style.color = d.server && d.server.consistent === true ? 'var(--ok)' : 'var(--bad)';
        if (d.server && d.server.error){
          showBanner('这台服务器连不上：' + d.server.error + ' —— 换一台，或者让 agent 帮你接一台新的。');
        } else {
          hideBanner();
        }
        q('dirty').textContent = d.gitStatus && d.gitStatus.clean === false ? (d.gitStatus.dirty + ' 处未提交') : '干净';
        q('dirty').style.color = d.gitStatus && d.gitStatus.clean === false ? 'var(--warn)' : 'var(--dim)';
        renderGit(d.git || [], d.gitStatus);
        renderReleases(d);
        q('log').textContent = (d.log && d.log.length) ? d.log.join('\\n') : '（暂无日志）';
        // 到这里说明这次请求真的成功了，才把组合记下来。
        remember(STORE_PROJECT, currentProject);
        remember(STORE_SERVER, currentServer);
      })
      .catch(function(error){
        // 记忆里的服务器可能已经被删：退回项目默认再试一次，别让页面卡死在报错上。
        if (currentServer && String(error.message).indexOf('未知服务器') >= 0){
          currentServer = projectDefaultServer(currentProject);
          remember(STORE_SERVER, currentServer);
          load();
          return;
        }
        toast('读取失败：' + error.message, 'err');
      })
      .finally(function(){
        q('btn-refresh').disabled = false;
        q('btn-refresh').textContent = '刷新';
      });
  }

  function setBusy(value){
    busy = value;
    q('btn-release').disabled = value;
    q('btn-confirm').disabled = value;
    var buttons = document.querySelectorAll('[data-rollback]');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = value;
  }

  // 操作系统详情：字段不多，但排障时每一行都可能是关键信息。
  function showOs(os, kind){
    var platformName = kind === 'windows' ? 'Windows' : (kind === 'linux' ? 'Linux' : (os.platform || '未知'));
    var rows = [
      ['系统', os.name || '未知'],
      ['版本', os.version || '—'],
      ['类型', platformName],
      ['架构', os.arch || '—'],
      ['内核', os.kernel || '—'],
      ['主机名', os.hostname || '—'],
      ['Node', os.node || '—']
    ];
    var html = '';
    for (var i = 0; i < rows.length; i++){
      html += '<dt>' + escapeHtml(rows[i][0]) + '</dt><dd>' + escapeHtml(rows[i][1]) + '</dd>';
    }
    q('os-body').innerHTML = html;
    q('os-hint').textContent = '这些值由服务器上的部署器进程自己读取，只读，不执行任何命令。';
    q('os-dlg').showModal();
  }

  q('os').addEventListener('click', function(){
    var d = overviewData;
    if (!d || !d.server || !d.server.os){
      toast('拿不到操作系统信息：服务器不可达，或部署器版本过旧', 'err');
      return;
    }
    showOs(d.server.os, d.server.kind);
  });
  q('os-close').addEventListener('click', function(){ q('os-dlg').close(); });

  q('btn-refresh').addEventListener('click', load);

  // 落点路径点一下就复制，方便拿去 RDP 或命令行里看。
  function copyText(text){
    function fallback(){
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); toast('已复制 ' + text, 'ok'); }
      catch (e) { toast('复制失败，请手动选中', 'err'); }
      document.body.removeChild(area);
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ toast('已复制 ' + text, 'ok'); }, fallback);
      return;
    }
    fallback();
  }

  q('root').addEventListener('click', function(){
    var text = this.textContent;
    if (!text || text === '—'){ toast('服务器不可达，没有路径', 'err'); return; }
    copyText(text);
  });

  q('btn-root').addEventListener('click', function(){ openServerBrowser(); });

  // ---- 接入新服务器：把「怎么接」写成一段能直接交给 agent 的话 ----
  function buildJoinPrompt(host, platform){
    var target = host && host.trim() ? host.trim() : '<目标机器地址>';
    var os = platform === 'linux' ? 'Linux' : 'Windows';
    var profileWhere = PROFILES_FILE !== ''
      ? PROFILES_FILE
      : '档案文件 deploy-profiles.json（可能由 AIRLOCK_DEPLOY_PROFILES_FILE 环境变量指定）';
    var lines = [
      '帮我把一台新机器接成 Airlock 的部署目标。',
      '',
      '【工具】Airlock 装在本机 ' + AIRLOCK_ROOT + '（' + HOST_OS + '）',
      '【档案】' + profileWhere,
      '【目标】' + target + '（' + os + '）',
      '',
      '按顺序做，每一步都要验证结果，不要假设上一步已经生效：',
      ''
    ];

    if (os === 'Windows') {
      lines = lines.concat([
        '1. 先测目标机 22 端口，区分两种失败：',
        '   · 连接超时 = 包被丢掉（云安全组或防火墙），22 没放行要我本人去云控制台开，agent 开不了；',
        '   · 连接拒绝 = 端口通了但 sshd 没在监听。',
        '   只有 3389/21 能通、22 超时，是最常见的第一道坎。',
        '2. 装 Node ≥ 24，记下 node.exe 的绝对路径，后面 deployer 命令要用。',
        '3. 建部署账号（默认 ag-ssh）+ 专用密钥。这一步最容易翻车，三个必查项：',
        '   a. 公钥必须写进「真实的 profile 目录」——Windows 上常常是 C:' + SEP + 'Users' + SEP + 'ag-ssh.<机器名>，',
        '      不是 C:' + SEP + 'Users' + SEP + 'ag-ssh。用注册表 ProfileList 查实际目录，别猜。',
        '   b. sshd_config 里如果有 AllowGroups / AllowUsers，新账号必须在名单里，',
        '      否则密钥再对也会被拒，而日志只会说 publickey denied。',
        '   c. authorized_keys 必须是 ASCII 或 UTF-8 无 BOM，写文件时显式指定编码。',
        '4. 配 sshd 的 Match User + ForceCommand（只允许走部署通道）。',
        '   改之前先挂一个 10 分钟自动回滚的计划任务，改完立刻测一次能登进来再继续。',
        '5. 把 ' + AIRLOCK_ROOT + ' 里的 bin/ 和 src/ 拷到目标机，写 config/deployer.json',
        '   （应用 id、root、start/stop、健康检查）。root 默认放管理员桌面。',
        '6. 在档案里加一个 servers 条目，然后跑',
        '   node "' + AIRLOCK_ROOT + SEP + 'bin' + SEP + 'airlock-deploy.mjs" status --app <应用>',
        '   确认能连通、能看到 root。',
        '',
        '已知的坑（上次接机器时真遇到过，别重复）：',
        '· Windows 防火墙规则 OpenSSH-Server-In-TCP 可能是 Disabled，而且只覆盖 Private 配置文件。',
        '  表现就是「服务 Running、22 依然不通」。要启用它并覆盖实际使用的配置文件（Domain/Public）。',
        '· 改 authorized_keys 的 ACL 时不要用 /inheritance:r 一刀切，那会把 Administrators 也锁在外面。',
        '  保留 SYSTEM 和 Administrators 的访问权。',
        '· 不要复用日常或 RDP 账号做部署账号：同一账号 SSH 与 RDP 会互踢会话。'
      ]);
    } else {
      lines = lines.concat([
        '1. 先测目标机 22 端口。连接超时要区分是云安全组丢包还是 sshd 没起。',
        '2. 装 Node ≥ 24，记下 node 的绝对路径。',
        '3. 建部署账号（默认 ag-ssh）+ 专用密钥，写进 ~/.ssh/authorized_keys，权限 600、目录 700。',
        '4. 配 sshd 的 Match User + ForceCommand（只允许走部署通道）。',
        '   改之前先挂一个 10 分钟自动回滚的 cron/systemd timer，改完立刻测一次能登进来再继续。',
        '5. 把 ' + AIRLOCK_ROOT + ' 里的 bin/ 和 src/ 拷到目标机，写 config/deployer.json',
        '   （应用 id、root、start/stop、健康检查）。root 按目标机的惯例选，别放在会被清理的目录。',
        '6. 在档案里加一个 servers 条目，然后跑',
        '   node "' + AIRLOCK_ROOT + SEP + 'bin' + SEP + 'airlock-deploy.mjs" status --app <应用>',
        '   确认能连通、能看到 root。',
        '',
        '已知的坑：',
        '· 不要复用日常账号做部署账号；SSH 的 ForceCommand 会影响这个账号的所有登录。',
        '· deployer 是裸进程托管时，systemd 的 KillMode 若为 control-group，ssh 断开可能连带收掉子进程。'
      ]);
    }

    return lines.concat([
      '',
      '做完告诉我：服务器名字、应用 id、落点路径、要开哪些端口。'
    ]).join('\\n');
  }

  function refreshJoinPrompt(){
    q('join-prompt').value = buildJoinPrompt(q('join-host').value, q('join-platform').value);
  }

  function openJoin(){
    q('join-dlg').showModal();
    refreshJoinPrompt();
    q('join-host').focus();
  }

  q('btn-join').addEventListener('click', openJoin);
  q('join-host').addEventListener('input', refreshJoinPrompt);
  q('join-platform').addEventListener('change', refreshJoinPrompt);
  q('join-cancel').addEventListener('click', function(){ q('join-dlg').close(); });
  q('join-copy').addEventListener('click', function(){ copyText(q('join-prompt').value); });

  // 连接失败时给一条出路：不是让你去翻文档，是直接给 agent 一段话。
  function showBanner(text){
    q('banner-text').textContent = text;
    q('banner').classList.add('show');
  }
  function hideBanner(){ q('banner').classList.remove('show'); }
  q('banner-action').addEventListener('click', openJoin);

  // 项目切换器：每个项目对应一个档案（服务器）+ 应用 + 本地目录。
  (function initProjects(){
    var sel = q('project-select');
    if (PROJECTS.length <= 1){ sel.style.display = 'none'; return; }
    var html = '';
    for (var i = 0; i < PROJECTS.length; i++){
      var item = PROJECTS[i];
      html += '<option value="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) +
              ' · ' + escapeHtml(item.app) + '</option>';
    }
    sel.innerHTML = html;
    sel.value = currentProject;
  })();

  q('project-select').addEventListener('change', function(){
    if (busy) return;
    var value = this.value;
    if (value.indexOf('__server__:') === 0){
      var appId = value.slice('__server__:'.length);
      this.value = currentProject;
      openAddProject(appId);
      return;
    }
    currentProject = value;
    currentServer = projectDefaultServer(value);   // 切项目时跟它自己的默认目标机走
    remember(STORE_PROJECT, currentProject);
    remember(STORE_SERVER, currentServer);
    q('git-panel').innerHTML = '<div class="skel"></div><div class="skel"></div>';
    q('rel-panel').innerHTML = '<div class="skel"></div><div class="skel"></div>';
    q('log').textContent = '加载中…';
    load();
  });

  /**
   * 服务器下拉：同一份代码可以发到不同机器。只列真实服务器，不再有「项目默认」这一项。
   * 记忆里的机器如果已被删掉，退回项目的默认服务器，再退到第一台。
   */
  function rebuildServerSelect(list, selected){
    var sel = q('server-select');
    if (!list || !list.length){ sel.style.display = 'none'; return; }
    sel.style.display = '';
    var html = '';
    var ids = [];
    for (var i = 0; i < list.length; i++){
      var s = list[i];
      ids.push(s.id);
      html += '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.id) + ' · ' + escapeHtml(s.host) + '</option>';
    }
    html += '<option value="__add__">＋ 接入新服务器…</option>';
    sel.innerHTML = html;

    if (ids.indexOf(selected) < 0){
      selected = projectDefaultServer(currentProject);
      if (ids.indexOf(selected) < 0) selected = ids[0];
      currentServer = selected;
    }
    sel.value = selected || '';
  }

  q('server-select').addEventListener('change', function(){
    if (busy) return;
    if (this.value === '__add__'){
      this.value = currentServer;
      openJoin();
      return;
    }
    currentServer = this.value;
    remember(STORE_SERVER, currentServer);
    load();
  });

  // ---- 添加项目 ----
  /**
   * 项目下拉 = 本地档案里的项目 + 当前服务器上有、但本地还没配目录的应用。
   * 后者选中会打开「＋ 项目」并预填 app——发布需要本地目录，光有 app id 发不了。
   * 本地项目也会标出「此服务器无此应用」，免得切机器后对着一个不存在的 app 发版。
   */
  function rebuildProjectSelect(list, serverApps){
    var sel = q('project-select');
    var apps = serverApps || [];
    var onThisServer = {};
    for (var k = 0; k < apps.length; k++) onThisServer[apps[k].id] = true;

    var covered = {};
    var html = '';
    for (var i = 0; i < list.length; i++){
      var item = list[i];
      covered[item.app] = true;
      var mark = onThisServer[item.app] ? '' : ' · 此服务器无此应用';
      html += '<option value="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) +
              ' · ' + escapeHtml(item.app) + mark + '</option>';
    }

    var extra = '';
    for (var j = 0; j < apps.length; j++){
      var app = apps[j];
      if (!app.id || covered[app.id]) continue;
      extra += '<option value="__server__:' + escapeHtml(app.id) + '">' +
               escapeHtml(app.id) + ' · 服务器上有，本地未配置</option>';
    }
    if (extra) html += '<option disabled>──────────</option>' + extra;

    sel.innerHTML = html;
    sel.style.display = (list.length + (extra ? 1 : 0)) <= 1 ? 'none' : '';
    sel.value = currentProject;
  }

  function openAddProject(appId){
    q('add-path').value = '';
    q('add-name').value = appId || '';
    q('add-app').value = appId || '';
    q('add-path-hint').textContent = appId
      ? '给服务器上的应用 ' + appId + ' 配一个本地目录'
      : '默认从桌面开始，可以切到任意盘符';
    q('add-dlg').showModal();
    q('add-path').focus();
  }

  function guessName(path){
    var parts = String(path).split(/[\\\\/]+/).filter(Boolean);
    var base = parts.length ? parts[parts.length - 1] : '';
    return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  q('btn-add').addEventListener('click', function(){ openAddProject(''); });

  /**
   * 浏览器只能给出文件夹名，让服务端去常用位置找真实路径。
   * 找不到就把弹窗留着，让用户手动粘贴完整路径。
   */
  function locateFolder(folderName){
    q('add-dlg').showModal();
    if (!q('add-name').value) q('add-name').value = guessName(folderName);
    toast('正在查找 ' + folderName + ' 的位置…', '');
    api('/api/find-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: folderName })
    }).then(function(res){
      if (res.status === 200 && res.body.ok && res.body.paths && res.body.paths.length){
        var found = res.body.paths[0];
        q('add-path').value = found;
        q('add-path-hint').textContent = res.body.paths.length > 1
          ? '找到 ' + res.body.paths.length + ' 个同名文件夹，已填第一个：' + found + '（不对就手改）'
          : '已定位到 ' + found;
        toast('找到了 ' + folderName, 'ok');
      } else {
        q('add-path-hint').textContent = '没能自动定位「' + folderName + '」，请手动粘贴完整路径';
        toast('没找到完整路径，请手动填写', 'err');
      }
    }).catch(function(error){ toast('查找失败：' + error.message, 'err'); });
  }

  // ---- 服务器目录：走部署通道列目录，改的是服务器上的落点 ----
  var browseCurrent = '';
  var browseParent = null;

  function openServerBrowser(){
    q('browse-dlg').showModal();
    loadDir('');
  }

  function loadDir(path){
    q('browse-list').innerHTML = '<div class="empty">读取中…</div>';
    var url = '/api/server-ls?project=' + encodeURIComponent(currentProject)
            + (currentServer ? '&server=' + encodeURIComponent(currentServer) : '')
            + (path ? '&path=' + encodeURIComponent(path) : '');
    api(url).then(function(res){
      if (res.status !== 200) throw new Error(res.body.error ? res.body.error.message : '读取失败');
      var d = res.body;
      browseCurrent = d.path;
      browseParent = d.parent;
      q('browse-path').value = d.path;
      q('browse-up').disabled = !d.parent;
      var places = d.places || [];
      var ph = '';
      for (var i = 0; i < places.length; i++){
        ph += '<button type="button" data-place="' + escapeHtml(places[i].path) + '">' + escapeHtml(places[i].name) + '</button>';
      }
      q('browse-places').innerHTML = ph;
      var list = d.entries || [];
      var html = '';
      for (var j = 0; j < list.length; j++){
        var e = list[j];
        html += '<div class="row" data-path="' + escapeHtml(e.path) + '" data-dir="' + (e.dir ? '1' : '0') + '">' +
                  '<span class="ico">' + (e.dir ? '▸' : '·') + '</span>' +
                  '<span class="nm">' + escapeHtml(e.name) + '</span></div>';
      }
      if (!html) html = '<div class="empty">这个目录是空的</div>';
      else if (d.truncated) html += '<div class="empty">目录太大，只显示了一部分</div>';
      q('browse-list').innerHTML = html;
    }).catch(function(error){
      q('browse-list').innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
  }

  /** 改服务器上的发布落点。历史版本留在旧目录，新落点需要重新发一版。 */
  function setServerRoot(path){
    toast('正在把服务器落点改到 ' + path + ' …', '');
    api('/api/set-root', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: currentProject, server: currentServer, root: path })
    }).then(function(res){
      if (res.status === 200 && res.body.ok){
        toast('服务器落点已改为 ' + path + '，重新发一版才会生效', 'ok');
        load();
      } else {
        toast('改落点失败：' + (res.body.error ? res.body.error.message : '未知错误'), 'err');
      }
    }).catch(function(error){ toast('改落点失败：' + error.message, 'err'); });
  }

  q('browse-places').addEventListener('click', function(event){
    var button = event.target.closest ? event.target.closest('button[data-place]') : null;
    if (button) loadDir(button.getAttribute('data-place'));
  });

  q('browse-list').addEventListener('click', function(event){
    var row = event.target.closest ? event.target.closest('.row') : null;
    if (!row) return;
    if (row.getAttribute('data-dir') === '1') loadDir(row.getAttribute('data-path'));
  });

  q('browse-up').addEventListener('click', function(){ if (browseParent) loadDir(browseParent); });
  q('browse-go').addEventListener('click', function(){
    var value = q('browse-path').value.trim();
    if (value) loadDir(value);
  });
  q('browse-path').addEventListener('keydown', function(event){
    if (event.key === 'Enter'){ event.preventDefault(); q('browse-go').click(); }
  });
  q('browse-cancel').addEventListener('click', function(){ q('browse-dlg').close(); });
  q('browse-ok').addEventListener('click', function(){
    if (!browseCurrent){ toast('还没有进入任何目录', 'err'); return; }
    q('browse-dlg').close();
    setServerRoot(browseCurrent);
  });

  // ---- 本地目录：用系统默认的文件夹选择窗口 ----
  var pickTarget = null;

  function chooseLocalFolder(input){
    pickTarget = input;
    var picker = q('add-picker');
    if (typeof picker.showPicker === 'function'){
      try { picker.showPicker(); return; } catch (error) { /* 有些环境不允许，退回 click */ }
    }
    picker.click();
  }

  q('add-picker').addEventListener('change', function(){
    var files = this.files;
    if (!files || !files.length) return;
    var rel = files[0].webkitRelativePath || '';
    var folderName = rel.split('/')[0] || '';
    this.value = '';
    var target = pickTarget;
    if (!folderName){ toast('没识别到文件夹名，请手动填写路径', 'err'); return; }
    if (target) resolveLocalFolder(target, folderName);
  });

  /** 浏览器只给文件夹名，让服务端去常用位置反查完整路径。 */
  function resolveLocalFolder(input, folderName){
    if (input.id === 'add-path'){
      if (!q('add-name').value){
        var guessed = guessName(folderName);
        // 项目名只能用 ASCII：中文目录名规范化后可能为空，给个占位让用户自己改。
        q('add-name').value = guessed !== '' ? guessed : 'project';
      }
      q('add-path-hint').textContent = '正在查找「' + folderName + '」的位置…';
    }
    api('/api/find-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: folderName })
    }).then(function(res){
      var found = (res.status === 200 && res.body.ok && res.body.paths) ? res.body.paths : [];
      if (found.length){
        input.value = found[0];
        var note = found.length > 1
          ? '找到 ' + found.length + ' 个同名目录，已填第一个：' + found[0] + '（不对就手改）'
          : '已定位到 ' + found[0];
        if (input.id === 'add-path') q('add-path-hint').textContent = note;
        else q('source-hint').textContent = note;
      } else {
        var miss = '没找到「' + folderName + '」的完整路径，请手动粘贴';
        if (input.id === 'add-path') q('add-path-hint').textContent = miss;
        else q('source-hint').textContent = miss;
        toast(miss, 'err');
      }
    }).catch(function(error){ toast('查找失败：' + error.message, 'err'); });
  }

  q('add-browse').addEventListener('click', function(){ chooseLocalFolder(q('add-path')); });

  q('add-confirm').addEventListener('click', function(){
    var path = q('add-path').value.trim();
    var name = q('add-name').value.trim();
    var app = q('add-app').value.trim();
    if (!path){ toast('请选择项目目录', 'err'); return; }
    if (!name){ toast('请填写项目名', 'err'); return; }
    if (!app){ toast('请填写服务器上的应用 id', 'err'); return; }
    var button = q('add-confirm');
    button.disabled = true;
    api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, app: app, workspace: path })
    }).then(function(res){
      if (res.status === 200 && res.body.ok){
        q('add-dlg').close();
        currentProject = res.body.name;
        toast('已添加项目 ' + res.body.name, 'ok');
        load();
      } else {
        toast('添加失败：' + (res.body.error ? res.body.error.message : '未知错误'), 'err');
      }
    }).catch(function(error){
      toast('添加失败：' + error.message, 'err');
    }).finally(function(){ button.disabled = false; });
  });

  // 拖拽：浏览器只给文件夹名，所以让服务端去常用目录里找真实路径。
  var dragDepth = 0;
  document.addEventListener('dragenter', function(event){
    event.preventDefault();
    dragDepth += 1;
    if (dragDepth === 1) q('drop-veil').classList.add('show');
  });
  document.addEventListener('dragover', function(event){ event.preventDefault(); });
  document.addEventListener('dragleave', function(event){
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) q('drop-veil').classList.remove('show');
  });
  document.addEventListener('drop', function(event){
    event.preventDefault();
    dragDepth = 0;
    q('drop-veil').classList.remove('show');
    var items = event.dataTransfer && event.dataTransfer.items;
    var name = '';
    if (items && items.length){
      var entry = items[0].webkitGetAsEntry ? items[0].webkitGetAsEntry() : null;
      name = entry ? entry.name : (items[0].getAsFile() ? items[0].getAsFile().name : '');
    }
    if (!name){ toast('没识别到文件夹，试试点「选择文件夹」', 'err'); return; }
    locateFolder(name);
  });

  function syncSourceMode(){
    var custom = q('in-source-select').value === '__custom__';
    q('in-source-row').style.display = custom ? 'flex' : 'none';
    q('source-hint').textContent = custom
      ? '填绝对路径，比如 D:\\work\\my-project\\dist'
      : '自动探测到的构建产物目录，发布前请确认内容';
    if (custom) q('in-source').focus();
  }

  q('in-source-select').addEventListener('change', syncSourceMode);
  q('btn-source-browse').addEventListener('click', function(){ chooseLocalFolder(q('in-source')); });

  q('btn-release').addEventListener('click', function(){
    if (busy) return;
    var sel = q('in-source-select');
    var html = '';
    var list = overviewData && overviewData.candidates ? overviewData.candidates : [];
    for (var i = 0; i < list.length; i++){
      var c = list[i];
      html += '<option value="' + escapeHtml(c.path) + '">' + escapeHtml(c.label) +
              '（' + c.files + ' 项）</option>';
    }
    html += '<option value="__custom__">自定义路径…</option>';
    sel.innerHTML = html;
    sel.value = list.length ? list[0].path : '__custom__';
    q('in-version').value = '';
    q('in-source').value = '';
    syncSourceMode();
    q('dlg').showModal();
  });

  q('btn-confirm').addEventListener('click', function(){
    if (busy) return;
    var sel = q('in-source-select');
    var source = sel.value === '__custom__' ? q('in-source').value.trim() : sel.value;
    if (!source){ toast('请选择一个发布目录', 'err'); return; }
    q('dlg').close();
    setBusy(true);
    toast('发布中…', '');
    api('/api/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: currentProject,
        server: currentServer,
        source: source,
        version: q('in-version').value.trim()
      })
    }).then(function(res){
      if (res.status === 200 && res.body.ok){
        var h = res.body.activated && res.body.activated.health;
        toast('已发布 ' + res.body.version + (h ? '（健康：' + h.detail + '）' : ''), 'ok');
      } else {
        toast('发布失败：' + (res.body.error ? res.body.error.message : '未知错误'), 'err');
      }
      load();
    }).catch(function(error){
      toast('发布失败：' + error.message, 'err');
      load();
    }).finally(function(){ setBusy(false); });
  });

  document.addEventListener('click', function(event){
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var version = target.getAttribute('data-rollback');
    if (!version || busy) return;
    if (!confirm('确认把 ' + APP + ' 回退到 ' + version + ' ？\\n\\n会先停止服务、切换版本、再启动并做健康检查。')) return;
    setBusy(true);
    toast('回退中…', '');
    api('/api/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: currentProject, server: currentServer, to: version })
    }).then(function(res){
      if (res.status === 200 && res.body.ok){
        var r = res.body.result || {};
        toast('已回退 ' + (r.from || '?') + ' → ' + (r.to || version), 'ok');
      } else {
        toast('回退失败：' + (res.body.error ? res.body.error.message : '未知错误'), 'err');
      }
      load();
    }).catch(function(error){
      toast('回退失败：' + error.message, 'err');
      load();
    }).finally(function(){ setBusy(false); });
  });

  load();
})();
</script>
</body>
</html>`;
}
