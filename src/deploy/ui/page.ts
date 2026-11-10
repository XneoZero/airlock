/**
 * 控制台单页。没有构建步骤、没有依赖：一个 HTML 字符串，CSS 与 JS 内联。
 *
 * 注意：内联 JS 里刻意不用模板字符串（反引号），否则会和本文件外层的模板字符串打架。
 */
export interface PageOptions {
  readonly token: string;
  readonly app: string;
}

export function renderPage(options: PageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Airlock · ${options.app}</title>
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
  .spacer{flex:1}
  button{font:inherit;padding:7px 14px;border-radius:7px;border:1px solid var(--line);
         background:#1c222d;color:var(--text);cursor:pointer;transition:.15s}
  button:hover{border-color:#3a4356;background:#222a36}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover{background:#3f7ef0}
  button.danger{color:var(--bad);border-color:#4a2020}
  button.danger:hover{background:#2a1618;border-color:var(--bad)}
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
  #toast{position:fixed;right:20px;bottom:20px;max-width:420px;padding:12px 16px;border-radius:9px;
         background:#1c222d;border:1px solid var(--line);font-size:13px;opacity:0;
         transform:translateY(8px);transition:.2s;pointer-events:none;z-index:20;white-space:pre-wrap}
  #toast.show{opacity:1;transform:none}
  #toast.ok{border-color:rgba(63,185,80,.5)}
  #toast.err{border-color:rgba(248,81,73,.5)}
  .skel{height:14px;background:linear-gradient(90deg,#1b2029,#232a36,#1b2029);
        background-size:200% 100%;animation:sh 1.2s infinite;border-radius:4px;margin:10px 16px}
  @keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
</style>
</head>
<body>
<header>
  <h1>Airlock <b>·</b> <span id="app-name">${options.app}</span></h1>
  <div class="meta">
    <span>服务器 <b id="server">—</b></span>
    <span>当前版本 <b id="current">—</b></span>
    <span>一致性 <b id="consistent">—</b></span>
    <span>本地改动 <b id="dirty">—</b></span>
  </div>
  <div class="spacer"></div>
  <button id="btn-refresh">刷新</button>
  <button id="btn-release" class="primary">发布新版本</button>
</header>

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
      <input id="in-source" spellcheck="false" style="display:none;margin-top:8px" placeholder="输入绝对路径">
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

<script>
(function(){
  'use strict';
  var TOKEN = new URLSearchParams(location.search).get('t') || '';
  var APP = ${JSON.stringify(options.app)};
  var busy = false;
  var overviewData = null;

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
    api('/api/overview')
      .then(function(res){
        if (res.status !== 200){ throw new Error(res.body.error ? res.body.error.message : '读取失败'); }
        var d = res.body;
        overviewData = d;
        q('app-name').textContent = d.app;
        q('server').textContent = d.server && d.server.serverId ? d.server.serverId : '不可达';
        q('current').textContent = d.server && d.server.current ? d.server.current : '无';
        q('consistent').textContent = d.server && d.server.consistent === true ? '正常' : '不一致';
        q('consistent').style.color = d.server && d.server.consistent === true ? 'var(--ok)' : 'var(--bad)';
        q('dirty').textContent = d.gitStatus && d.gitStatus.clean === false ? (d.gitStatus.dirty + ' 处未提交') : '干净';
        q('dirty').style.color = d.gitStatus && d.gitStatus.clean === false ? 'var(--warn)' : 'var(--dim)';
        renderGit(d.git || [], d.gitStatus);
        renderReleases(d);
        q('log').textContent = (d.log && d.log.length) ? d.log.join('\\n') : '（暂无日志）';
      })
      .catch(function(error){ toast('读取失败：' + error.message, 'err'); })
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

  q('btn-refresh').addEventListener('click', load);

  function syncSourceMode(){
    var custom = q('in-source-select').value === '__custom__';
    q('in-source').style.display = custom ? 'block' : 'none';
    q('source-hint').textContent = custom
      ? '填绝对路径，比如 D:\\work\\my-project\\dist'
      : '自动探测到的构建产物目录，发布前请确认内容';
    if (custom) q('in-source').focus();
  }

  q('in-source-select').addEventListener('change', syncSourceMode);

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
      body: JSON.stringify({ to: version })
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
