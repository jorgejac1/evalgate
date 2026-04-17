/**
 * evalgate web UI — v0.5
 *
 * Returns a self-contained HTML string. No external deps, no CDN calls.
 * Inline CSS (dark theme) + vanilla JS SSE client.
 */

export function htmlDashboard(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>evalgate</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5}
body.light{background:#ffffff;color:#1f2328}
a{color:#58a6ff;text-decoration:none}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #21262d;background:#161b22}
body.light header{background:#f6f8fa;border-bottom-color:#d0d7de}
header h1{font-size:15px;font-weight:600;color:#58a6ff;letter-spacing:.02em}
#dot{width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0;transition:background .3s}
#dot.err{background:#f85149}
#status{font-size:11px;color:#8b949e}
body.light #status{color:#57606a}
#file-label{font-size:11px;color:#484f58}
body.light #file-label{color:#6e7781}
#theme-btn{margin-left:auto;background:none;border:1px solid #30363d;border-radius:6px;color:#8b949e;cursor:pointer;font-family:inherit;font-size:12px;padding:4px 10px;transition:border-color .2s,color .2s}
#theme-btn:hover{border-color:#58a6ff;color:#58a6ff}
body.light #theme-btn{border-color:#d0d7de;color:#57606a}
body.light #theme-btn:hover{border-color:#0969da;color:#0969da}
main{display:grid;grid-template-columns:1fr;gap:0;max-width:1100px;margin:0 auto;padding:20px 16px;gap:24px}
@media(min-width:800px){main{grid-template-columns:320px 1fr}}
section h2{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#8b949e;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #21262d}
body.light section h2{color:#57606a;border-bottom-color:#d0d7de}
/* contracts */
#contracts-list{display:flex;flex-direction:column;gap:6px}
.contract{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:6px;border:1px solid #21262d;background:#161b22;transition:border-color .2s}
body.light .contract{background:#f6f8fa;border-color:#d0d7de}
.contract:hover{border-color:#30363d}
body.light .contract:hover{border-color:#0969da}
.mark{font-size:14px;flex-shrink:0;margin-top:1px}
.contract-body{flex:1;min-width:0}
.contract-title{color:#e6edf3;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.light .contract-title{color:#1f2328}
.contract-meta{font-size:10px;color:#484f58;margin-top:2px}
body.light .contract-meta{color:#6e7781}
.badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600}
.badge.passed{background:#1c4731;color:#3fb950}
.badge.failed{background:#4d1a1a;color:#f85149}
.badge.pending{background:#222;color:#8b949e}
.badge.flaky{background:#3a2a00;color:#e3b341}
body.light .badge.pending{background:#eaeef2;color:#57606a}
/* run history */
#runs-wrap{grid-column:1/-1}
@media(min-width:800px){#runs-wrap{grid-column:2}}
table{width:100%;border-collapse:collapse}
th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #21262d;font-size:12px}
body.light th,body.light td{border-bottom-color:#d0d7de}
th{color:#8b949e;font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
body.light th{color:#57606a}
td{color:#e6edf3}
body.light td{color:#1f2328}
tr:hover td{background:#161b22}
body.light tr:hover td{background:#f6f8fa}
.ok{color:#3fb950}
.fail{color:#f85149}
.dim{color:#484f58}
body.light .dim{color:#6e7781}
/* budget */
#budget-wrap{grid-column:1/-1}
.budget-item{padding:9px 10px;border-radius:6px;border:1px solid #21262d;background:#161b22;margin-bottom:6px}
body.light .budget-item{background:#f6f8fa;border-color:#d0d7de}
.budget-header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.budget-title{font-size:12px;font-weight:500;color:#e6edf3;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.light .budget-title{color:#1f2328}
.budget-status{font-size:10px;font-weight:600;padding:1px 6px;border-radius:10px}
.budget-status.ok{background:#1c4731;color:#3fb950}
.budget-status.exceeded{background:#4d1a1a;color:#f85149}
.progress-bar-wrap{background:#21262d;border-radius:4px;height:6px;overflow:hidden;margin-bottom:4px}
body.light .progress-bar-wrap{background:#d0d7de}
.progress-bar{height:100%;border-radius:4px;transition:width .4s ease}
.progress-bar.ok{background:#3fb950}
.progress-bar.exceeded{background:#f85149}
.budget-meta{font-size:10px;color:#484f58;display:flex;gap:16px}
body.light .budget-meta{color:#6e7781}
/* patterns */
#patterns-wrap{grid-column:1/-1}
.pattern-item{padding:9px 10px;border-radius:6px;border:1px solid #21262d;background:#161b22;margin-bottom:6px}
body.light .pattern-item{background:#f6f8fa;border-color:#d0d7de}
.pattern-header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.pattern-title{font-size:12px;font-weight:500;color:#e6edf3;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.light .pattern-title{color:#1f2328}
.fail-bar-wrap{background:#21262d;border-radius:4px;height:6px;overflow:hidden;margin-bottom:4px}
body.light .fail-bar-wrap{background:#d0d7de}
.fail-bar{height:100%;border-radius:4px;background:#f85149;transition:width .4s ease}
.pattern-meta{font-size:10px;color:#484f58;display:flex;gap:16px;margin-bottom:4px}
body.light .pattern-meta{color:#6e7781}
.pattern-errors{margin-top:4px}
.pattern-error{font-size:10px;color:#8b949e;padding:2px 6px;background:#0d1117;border-radius:3px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.light .pattern-error{background:#eaeef2;color:#57606a}
/* messages */
#messages-wrap{grid-column:1/-1}
.msg{padding:7px 10px;border-radius:6px;border:1px solid #21262d;background:#161b22;margin-bottom:6px}
body.light .msg{background:#f6f8fa;border-color:#d0d7de}
.msg-header{display:flex;gap:8px;align-items:center;margin-bottom:3px}
.msg-kind{font-size:10px;font-weight:600;color:#d2a8ff;background:#2d1f4a;padding:1px 7px;border-radius:10px}
.msg-route{font-size:11px;color:#8b949e}
body.light .msg-route{color:#57606a}
.msg-ts{font-size:10px;color:#484f58}
body.light .msg-ts{color:#6e7781}
.msg-payload{font-size:11px;color:#8b949e;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.light .msg-payload{color:#57606a}
.empty{color:#484f58;font-size:12px;padding:10px 0;text-align:center}
body.light .empty{color:#6e7781}
</style>
</head>
<body>
<header>
  <span id="dot" class="err"></span>
  <h1>evalgate</h1>
  <span id="status">connecting…</span>
  <span id="file-label"></span>
  <button id="theme-btn" onclick="toggleTheme()" title="Toggle theme">&#9788;</button>
</header>
<main>
  <section id="contracts-wrap">
    <h2>Contracts</h2>
    <div id="contracts-list"><p class="empty">loading…</p></div>
  </section>
  <section id="runs-wrap">
    <h2>Run History</h2>
    <div id="runs-list"><p class="empty">loading…</p></div>
  </section>
  <section id="budget-wrap" style="grid-column:1/-1">
    <h2>Budget</h2>
    <div id="budget-list"><p class="empty">loading…</p></div>
  </section>
  <section id="patterns-wrap" style="grid-column:1/-1">
    <h2>Failure Patterns</h2>
    <div id="patterns-list"><p class="empty">loading…</p></div>
  </section>
  <section id="messages-wrap" style="grid-column:1/-1">
    <h2>Agent Messages</h2>
    <div id="messages-list"><p class="empty">loading…</p></div>
  </section>
</main>
<script>
// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------
(function() {
  var saved = localStorage.getItem('gl-theme');
  if (saved === 'light') {
    document.body.classList.add('light');
    document.getElementById('theme-btn').textContent = '\\u263D'; // crescent moon
  }
})();

function toggleTheme() {
  var btn = document.getElementById('theme-btn');
  if (document.body.classList.contains('light')) {
    document.body.classList.remove('light');
    localStorage.setItem('gl-theme', 'dark');
    btn.innerHTML = '&#9788;'; // sun
  } else {
    document.body.classList.add('light');
    localStorage.setItem('gl-theme', 'light');
    btn.innerHTML = '&#9789;'; // crescent
  }
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------
var es = null;
function connect() {
  if (es) { try { es.close(); } catch(e){} }
  es = new EventSource('/api/stream');
  es.onopen = function() {
    document.getElementById('dot').className = '';
    document.getElementById('status').textContent = 'live';
  };
  es.onerror = function() {
    document.getElementById('dot').className = 'err';
    document.getElementById('status').textContent = 'reconnecting…';
    setTimeout(connect, 3000);
  };
  es.onmessage = function() { fetchState(); };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(iso) {
  var d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return Math.round(d/1000) + 's ago';
  if (d < 3600000) return Math.round(d/60000) + 'm ago';
  return new Date(iso).toLocaleTimeString();
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// ---------------------------------------------------------------------------
// Render: Contracts
// ---------------------------------------------------------------------------
function renderContracts(contracts) {
  var el = document.getElementById('contracts-list');
  if (!contracts || contracts.length === 0) {
    el.innerHTML = '<p class="empty">No contracts found</p>'; return;
  }
  var html = '';
  for (var i = 0; i < contracts.length; i++) {
    var c = contracts[i];
    var mark = c.checked ? '<span class="mark ok">&#10003;</span>' : (c.verifier ? '<span class="mark dim">&#9675;</span>' : '<span class="mark dim">&#183;</span>');
    var badge = c.checked ? '<span class="badge passed">passed</span>' : (c.verifier ? '<span class="badge pending">pending</span>' : '');
    var meta = c.verifier ? escHtml(c.verifier.command || '') : '<em>no verifier</em>';
    html += '<div class="contract">' + mark + '<div class="contract-body"><div class="contract-title">' + escHtml(c.title) + ' ' + badge + '</div><div class="contract-meta">' + meta + '</div></div></div>';
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Run History
// ---------------------------------------------------------------------------
function renderRuns(runs) {
  var el = document.getElementById('runs-list');
  if (!runs || runs.length === 0) {
    el.innerHTML = '<p class="empty">No runs yet</p>'; return;
  }
  var html = '<table><thead><tr><th></th><th>Contract</th><th>Trigger</th><th>Exit</th><th>Duration</th><th>When</th></tr></thead><tbody>';
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    var icon = r.passed ? '<span class="ok">&#10003;</span>' : '<span class="fail">&#10007;</span>';
    html += '<tr><td>' + icon + '</td><td>' + escHtml(r.contractTitle) + '</td><td class="dim">' + escHtml(r.trigger) + '</td><td class="dim">' + r.exitCode + '</td><td class="dim">' + r.durationMs + 'ms</td><td class="dim">' + timeAgo(r.ts) + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Budget
// ---------------------------------------------------------------------------
function renderBudget(budgetSummary) {
  var el = document.getElementById('budget-list');
  if (!budgetSummary) {
    el.innerHTML = '<p class="empty">No budget data</p>'; return;
  }
  // Only show contracts that have a budget set OR have token usage
  var visible = [];
  for (var i = 0; i < budgetSummary.length; i++) {
    var b = budgetSummary[i];
    if (b.budget !== undefined || b.used > 0) {
      visible.push(b);
    }
  }
  if (visible.length === 0) {
    el.innerHTML = '<p class="empty">No budget constraints defined</p>'; return;
  }
  var html = '';
  for (var j = 0; j < visible.length; j++) {
    var b = visible[j];
    var pct = 0;
    if (b.budget && b.budget > 0) {
      pct = Math.min(100, Math.round((b.used / b.budget) * 100));
    } else if (b.used > 0) {
      pct = 100; // usage but no limit — show full bar in neutral colour
    }
    var statusClass = b.exceeded ? 'exceeded' : 'ok';
    var statusLabel = b.exceeded ? 'exceeded' : 'ok';
    var barClass = b.exceeded ? 'exceeded' : 'ok';
    var budgetLabel = b.budget !== undefined ? fmtTokens(b.budget) : '—';
    html += '<div class="budget-item">';
    html += '<div class="budget-header">';
    html += '<span class="budget-title">' + escHtml(b.contractTitle) + '</span>';
    html += '<span class="budget-status ' + statusClass + '">' + statusLabel + '</span>';
    html += '</div>';
    html += '<div class="progress-bar-wrap"><div class="progress-bar ' + barClass + '" style="width:' + pct + '%"></div></div>';
    html += '<div class="budget-meta">';
    html += '<span>used: ' + fmtTokens(b.used) + '</span>';
    html += '<span>budget: ' + budgetLabel + '</span>';
    if (b.budget !== undefined) {
      html += '<span>' + pct + '%</span>';
    }
    html += '</div>';
    html += '</div>';
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Failure Patterns
// ---------------------------------------------------------------------------
function renderPatterns(patterns) {
  var el = document.getElementById('patterns-list');
  if (!patterns || patterns.length === 0) {
    el.innerHTML = '<p class="empty">No failure patterns detected</p>'; return;
  }
  var html = '';
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    var failPct = Math.round(p.failureRate * 100);
    var flakyBadge = p.flaky ? '<span class="badge flaky">flaky</span>' : '';
    html += '<div class="pattern-item">';
    html += '<div class="pattern-header">';
    html += '<span class="pattern-title">' + escHtml(p.contractTitle) + '</span>';
    html += flakyBadge;
    html += '</div>';
    html += '<div class="fail-bar-wrap"><div class="fail-bar" style="width:' + failPct + '%"></div></div>';
    html += '<div class="pattern-meta">';
    html += '<span>fail rate: ' + failPct + '%</span>';
    html += '<span>failures: ' + p.failures + '</span>';
    html += '<span>passes: ' + p.passes + '</span>';
    html += '<span>total: ' + p.totalRuns + '</span>';
    html += '</div>';
    if (p.topErrors && p.topErrors.length > 0) {
      html += '<div class="pattern-errors">';
      for (var j = 0; j < p.topErrors.length; j++) {
        html += '<div class="pattern-error">' + escHtml(p.topErrors[j]) + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Agent Messages
// ---------------------------------------------------------------------------
function renderMessages(messages) {
  var el = document.getElementById('messages-list');
  if (!messages || messages.length === 0) {
    el.innerHTML = '<p class="empty">No messages yet</p>'; return;
  }
  var html = '';
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
    html += '<div class="msg"><div class="msg-header"><span class="msg-kind">' + escHtml(m.kind) + '</span><span class="msg-route">' + escHtml(m.from) + ' &rarr; ' + escHtml(m.to) + '</span><span class="msg-ts">' + timeAgo(m.ts) + '</span></div><div class="msg-payload">' + escHtml(payload) + '</div></div>';
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Fetch state + render all sections
// ---------------------------------------------------------------------------
async function fetchState() {
  try {
    var r = await fetch('/api/state');
    var s = await r.json();
    if (s.todoPath) document.getElementById('file-label').textContent = s.todoPath;
    renderContracts(s.contracts);
    renderRuns(s.runs);
    renderBudget(s.budgetSummary);
    renderPatterns(s.patterns);
    renderMessages(s.messages);
  } catch(e) {
    console.error('fetchState error', e);
  }
}

connect();
fetchState();
// Also poll every 10s as fallback
setInterval(fetchState, 10000);
</script>
</body>
</html>`;
}
