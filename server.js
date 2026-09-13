import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);

const stages = ["待检查", "校准中", "待复核", "已交付"];
const statLabels = ["待检查", "校准中", "待复核", "已交付"];
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
const roles = ["计量员", "校准员", "复核员"];

const seed = {
  items: [
    {
      id: "MR-001",
      code: "MR-001",
      shipType: "福船",
      scale: "1:48",
      mastCount: 3,
      riggingMaterial: "蜡线",
      owner: "周宁",
      dueDate: "2026-06-28",
      status: "校准中",
      tasks: [
        { id: "T-1", position: "前桅侧支索", tension: "偏松", status: "调整中", measurements: [], reviews: [], logs: [{ at: "2026-06-12", note: "已缩短2mm" }] }
      ],
      logs: []
    }
  ],
  gauges: [
    { id: "G-1", code: "TJ-01", name: "张力计", validUntil: "2027-12-31", status: "在用", version: 1, registeredBy: "计量员", registeredAt: "2026-06-01T00:00:00.000Z", history: [] }
  ],
  batches: [],
  previews: []
};

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  db.gauges ||= [];
  db.batches ||= [];
  db.previews ||= [];
  for (const item of db.items) {
    item.id ||= item.code;
    item.tasks ||= [];
    item.logs ||= [];
    item.risks ||= (item.risk ? [item.risk] : []);
    delete item.risk;
    for (const task of item.tasks) {
      task.measurements ||= [];
      task.reviews ||= [];
      task.logs ||= [];
      for (const m of task.measurements) m.id ||= newId("M");
      if (task.lastReviewedMeasurementId === undefined) {
        // 旧数据迁移：按顺序配对，第 i 条复核对应第 i 条测量
        const idx = Math.min(task.reviews.length, task.measurements.length) - 1;
        task.lastReviewedMeasurementId = idx >= 0 ? task.measurements[idx].id : null;
      }
    }
  }
  for (const gauge of db.gauges) { gauge.version ||= 1; gauge.history ||= []; }
  return db;
}
async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// 写操作串行化，避免 load-modify-save 交错留下半批数据
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn);
  queue = run.then(() => {}, () => {});
  return run;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  send(res, status, { error: error.code || "internal_error", message: error.message });
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId(prefix) { return prefix + "-" + Date.now() + "-" + Math.floor(Math.random() * 1e6); }

function headerText(req, name) {
  const raw = req.headers[name] || "";
  try { return decodeURIComponent(raw); } catch { return raw; }
}
function requireRole(req, allowed) {
  const role = headerText(req, "x-role");
  const user = headerText(req, "x-user").trim();
  if (!allowed.includes(role)) throw new HttpError(403, "forbidden", "越权操作：需要" + allowed.join("或") + "身份");
  if (!user) throw new HttpError(400, "missing_user", "请先在页面右上角填写操作人姓名");
  return user;
}

function gaugeState(gauge) {
  if (gauge.status === "停用") return "停用";
  if (gauge.validUntil < today()) return "已过期";
  return "在用";
}
function findItem(db, key) { return db.items.find(x => x.id === key || x.code === key); }
function findGauge(db, key) { return db.gauges.find(g => g.id === key || g.code === key); }

function itemLockBatch(db, item) {
  for (const batch of db.batches) {
    if (batch.status !== "复测中") continue;
    for (const entry of batch.entries) {
      if (entry.itemId === item.id && entry.disposition === "退回校准" && entry.state !== "已复核") return batch;
    }
  }
  return null;
}
function batchProgress(batch) {
  const retest = batch.entries.filter(e => e.disposition === "退回校准");
  const done = retest.filter(e => e.state === "已复核").length;
  const risk = batch.entries.filter(e => e.disposition === "标风险").length;
  let nextStep = "已完成，流程已恢复";
  if (batch.status !== "已完成") {
    const pending = retest.find(e => e.state === "待复测");
    const reviewing = retest.find(e => e.state === "已复测");
    if (pending) nextStep = "等待校准员复测：" + pending.itemCode + " · " + pending.position;
    else if (reviewing) nextStep = "等待复核员复核：" + reviewing.itemCode + " · " + reviewing.position;
    else nextStep = "等待复核收尾";
  }
  return { ...batch, retestTotal: retest.length, retestDone: done, riskCount: risk, nextStep };
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}
function summarize(db, item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  const lock = itemLockBatch(db, item);
  return { ...item, logCount, locked: !!lock, lockBatchId: lock ? lock.id : null };
}
function affectedByGauge(db, gaugeId) {
  const out = [];
  for (const item of db.items) {
    for (const task of item.tasks) {
      if ((task.measurements || []).some(m => m.gaugeId === gaugeId)) out.push({ item, task });
    }
  }
  return out;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:140px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .warnpill { border-color:var(--warn); color:var(--warn); }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .identity { display:flex; gap:8px; align-items:center; } .identity select,.identity input { width:auto; min-width:110px; }
    #msg { display:none; margin-bottom:14px; padding:10px 14px; border-radius:6px; border:1px solid var(--line); background:#fff; }
    #msg.err { display:block; border-color:var(--warn); color:var(--warn); } #msg.ok { display:block; border-color:var(--accent); color:var(--accent); }
    .gauge-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:8px 0; border-top:1px solid var(--line); }
    .gauge-row:first-of-type { border-top:0; }
    .bar { height:8px; background:var(--line); border-radius:999px; overflow:hidden; } .bar i { display:block; height:100%; background:var(--accent); }
    .task { border-top:1px dashed var(--line); padding-top:6px; }
    #previewMask { display:none; position:fixed; inset:0; background:rgba(0,0,0,.35); align-items:center; justify-content:center; z-index:10; }
    #previewBox { background:#fff; border-radius:8px; padding:20px; max-width:560px; width:92%; max-height:80vh; overflow:auto; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务、量具追溯与复测批次闭环</div></div>
    <div class="identity">
      <select id="role">${roles.map(r => '<option>'+r+'</option>').join('')}</select>
      <input id="userName" placeholder="操作人姓名">
      <button id="reload">刷新</button>
    </div>
  </header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型（建档）</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      <form id="gaugeForm" style="margin-top:14px"><h2>量具登记（计量员）</h2><label>量具编号</label><input name="code" required><label>量具名称</label><input name="name" required><label>有效期至</label><input name="validUntil" type="date" required><button>登记量具</button></form>
      <form id="measureForm" style="margin-top:14px"><h2>帆索测量（校准员）</h2><label>选择模型</label><select id="mItem"></select><label>选择帆索</label><select id="mTask"></select><label>选择量具（仅显示有效量具）</label><select id="mGauge"></select><label>测量值</label><input id="mValue" placeholder="如 12.4N" required><label>备注</label><input id="mNote"><button>提交测量</button></form>
      <form id="reviewForm" style="margin-top:14px"><h2>帆索复核（复核员）</h2><label>选择模型</label><select id="rItem"></select><label>选择帆索</label><select id="rTask"></select><label>复核结论</label><select id="rResult"><option>通过</option><option>不通过</option></select><label>备注</label><input id="rNote"><button>提交复核</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div id="msg"></div>
      <div class="panel" style="margin-bottom:14px"><h2>量具台账</h2><div id="gauges"></div></div>
      <div class="panel" style="margin-bottom:14px"><h2>复测批次</h2><div class="grid" id="batches"></div></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select>
        <select id="gaugeFilter"><option value="">全部量具</option></select>
        <select id="riskFilter"><option value="">全部风险</option><option>复测中</option><option>有风险</option><option>正常</option></select>
        <select id="ownerFilter"><option value="">全部负责人</option></select>
        <input id="search" placeholder="搜索编号或关键词">
      </div>
      <div class="panel"><h2>创建模型后可拆分帆索任务，测量需选有效量具，复核通过后方可交付。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <div id="previewMask"><div id="previewBox"><h2>停用量具影响预览</h2><div id="previewBody"></div><div style="display:flex;gap:10px;margin-top:14px"><button id="confirmDeact" class="danger">确认停用并生成复测批次</button><button id="cancelDeact" class="secondary">取消</button></div></div></div>
  <script>
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const extraFields = ${JSON.stringify(extraFields)};
    let items = [], gauges = [], batches = [];
    let currentPreview = null;
    const $ = sel => document.querySelector(sel);
    const roleSel = $('#role'), userInput = $('#userName');
    roleSel.value = localStorage.getItem('role') || '校准员';
    userInput.value = localStorage.getItem('user') || '';
    roleSel.onchange = () => localStorage.setItem('role', roleSel.value);
    userInput.oninput = () => localStorage.setItem('user', userInput.value);
    function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }
    function showMsg(text, ok) { const m = $('#msg'); m.textContent = text; m.className = ok ? 'ok' : 'err'; clearTimeout(m._t); m._t = setTimeout(() => { m.className = ''; m.style.display = 'none'; }, 6000); m.style.display = 'block'; }
    async function api(path, options) {
      const opts = { ...(options || {}), headers: { 'Content-Type': 'application/json', 'x-role': encodeURIComponent(roleSel.value), 'x-user': encodeURIComponent(userInput.value) } };
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    function renderForms() {
      $('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      $('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function keepSelect(sel, html) { const old = sel.value; sel.innerHTML = html; if (old && [...sel.options].some(o => o.value === old)) sel.value = old; }
    function itemOptionsHtml() { return items.map(i => '<option value="'+esc(i.id)+'">'+esc(i.code)+' · '+esc(i.shipType || '')+'</option>').join(''); }
    function fillTasks(itemSel, taskSel) {
      const item = items.find(i => i.id === itemSel.value);
      const tasks = item ? (item.tasks || []) : [];
      taskSel.innerHTML = tasks.length ? tasks.map(t => '<option value="'+esc(t.id)+'">'+esc(t.position)+' · '+esc(t.status)+'</option>').join('') : '<option value="">（无帆索任务）</option>';
    }
    function renderSelects() {
      keepSelect($('#itemSelect'), itemOptionsHtml());
      keepSelect($('#mItem'), itemOptionsHtml());
      keepSelect($('#rItem'), itemOptionsHtml());
      fillTasks($('#mItem'), $('#mTask'));
      fillTasks($('#rItem'), $('#rTask'));
      const usable = gauges.filter(g => g.state === '在用');
      keepSelect($('#mGauge'), usable.length ? usable.map(g => '<option value="'+esc(g.id)+'">'+esc(g.code)+' · '+esc(g.name)+' · 有效期至 '+esc(g.validUntil)+'</option>').join('') : '<option value="">无可用量具</option>');
      keepSelect($('#gaugeFilter'), '<option value="">全部量具</option>' + gauges.map(g => '<option value="'+esc(g.id)+'">'+esc(g.code)+' · '+esc(g.name)+'</option>').join(''));
      const owners = [...new Set(items.map(i => i.owner).filter(Boolean))];
      keepSelect($('#ownerFilter'), '<option value="">全部负责人</option>' + owners.map(o => '<option>'+esc(o)+'</option>').join(''));
    }
    function renderStats() {
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      stats['复测批次'] = batches.filter(b => b.status === '复测中').length;
      stats['风险项目'] = items.filter(i => (i.risks || []).length > 0).length;
      $('#stats').innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
    }
    function renderGauges() {
      $('#gauges').innerHTML = gauges.length ? gauges.map(g =>
        '<div class="gauge-row"><b>'+esc(g.code)+'</b><span>'+esc(g.name)+'</span><span class="meta">有效期至 '+esc(g.validUntil)+'</span><span class="pill'+(g.state==='在用'?'':' warnpill')+'">'+g.state+'</span><span class="meta">v'+g.version+'</span>'+
        (g.status === '在用' ? '<button class="secondary" data-edit="'+esc(g.id)+'">改期</button><button class="danger" data-deact="'+esc(g.id)+'">停用</button>' : '<span class="meta">停用于 '+esc((g.deactivatedAt||'').slice(0,10))+'</span>')+'</div>'
      ).join('') : '<div class="meta">暂无量具，请计量员先登记。</div>';
      document.querySelectorAll('[data-deact]').forEach(btn => btn.onclick = () => deactivatePreview(btn.dataset.deact));
      document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => editValidity(btn.dataset.edit));
    }
    async function editValidity(id) {
      const g = gauges.find(x => x.id === id);
      if (!g) return;
      const d = prompt('新的有效期（YYYY-MM-DD）', g.validUntil);
      if (!d) return;
      try {
        await api('/api/gauges/'+id, { method:'PATCH', body: JSON.stringify({ validUntil: d, version: g.version }) });
        showMsg('量具 '+g.code+' 有效期已更新', true);
        await load();
      } catch (e) { showMsg(e.message); await load(); }
    }
    function renderBatches() {
      $('#batches').innerHTML = batches.length ? batches.map(b => {
        const pct = b.retestTotal ? Math.round(b.retestDone / b.retestTotal * 100) : 100;
        const entries = b.entries.map(e => '<div>'+esc(e.itemCode)+' · '+esc(e.position)+' · '+e.disposition+' · '+e.state+'</div>').join('');
        return '<article class="card"><h3>批次 '+esc(b.id)+'</h3><span class="pill'+(b.status==='复测中'?' warnpill':'')+'">'+b.status+'</span>'+
          '<div class="meta">量具 '+esc(b.gaugeCode)+' · '+esc(b.gaugeName)+' · '+esc(b.createdBy)+' 创建于 '+esc((b.createdAt||'').slice(0,10))+'</div>'+
          '<div class="bar"><i style="width:'+pct+'%"></i></div>'+
          '<div class="meta">退回校准 '+b.retestDone+'/'+b.retestTotal+' 已复核 · 标风险 '+b.riskCount+' 项</div>'+
          '<div><b>下一步：</b>'+esc(b.nextStep)+'</div>'+
          '<div class="logs meta">'+(entries || '无受影响帆索')+'</div></article>';
      }).join('') : '<div class="meta">暂无复测批次。</div>';
    }
    function visibleItems() {
      const status = $('#statusFilter').value, gf = $('#gaugeFilter').value, rk = $('#riskFilter').value, ow = $('#ownerFilter').value, q = $('#search').value.trim();
      return items.filter(item => {
        if (status && item.status !== status) return false;
        if (ow && item.owner !== ow) return false;
        if (gf) {
          const hit = (item.tasks || []).some(t => (t.measurements || []).some(m => m.gaugeId === gf)) || (item.risks || []).some(k => k.gaugeId === gf);
          if (!hit) return false;
        }
        if (rk === '复测中' && !item.locked) return false;
        if (rk === '有风险' && !(item.risks || []).length) return false;
        if (rk === '正常' && ((item.risks || []).length || item.locked)) return false;
        if (q && !JSON.stringify(item).includes(q)) return false;
        return true;
      });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => {
        const ms = (t.measurements || []).map(m => '<div>测量 '+esc(m.value)+' · 量具 '+esc(m.gaugeCode)+' '+esc(m.gaugeName)+' · '+esc(m.operator)+' · '+esc((m.at||'').slice(0,10))+(m.kind==='复测'?' <span class="pill warnpill">复测</span>':'')+'</div>').join('');
        const rs = (t.reviews || []).map(r => '<div>复核 '+esc(r.result)+' · '+esc(r.reviewer)+' · '+esc((r.at||'').slice(0,10))+(r.note?' · '+esc(r.note):'')+'</div>').join('');
        const rt = t.retest ? '<span class="pill'+(t.retest.state==='已复核'?'':' warnpill')+'">复测:'+t.retest.state+'</span>' : '';
        return '<div class="task"><div class="meta"><b>任务</b> '+esc(t.position)+' · '+esc(t.status)+' · '+esc(t.tension)+' '+rt+'</div>'+ms+rs+'</div>';
      }).join('');
      const risk = (item.risks || []).map(k => '<div class="warn">风险：量具 '+esc(k.gaugeCode)+' 已停用（批次 '+esc(k.batchId)+'），交付记录待评估，历史未改动</div>').join('');
      const locked = item.locked ? '<div class="warn">复测中（批次 '+esc(item.lockBatchId)+'），完成前不能推进到待复核/已交付</div>' : '';
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+main+risk+locked+tasks+
        '<label>状态</label><select data-status="'+esc(item.id)+'" '+(item.locked?'disabled':'')+'>'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'+
        '<button class="secondary" data-note="'+esc(item.id)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function renderCards() {
      $('#cards').innerHTML = visibleItems().map(cardHtml).join('') || '<div class="meta">没有匹配的模型。</div>';
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); }
        catch (e) { showMsg(e.message); await load(); }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const note = prompt('记录备注');
        if (note) { try { await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } catch (e) { showMsg(e.message); } }
      });
    }
    async function deactivatePreview(gaugeId) {
      try {
        currentPreview = await api('/api/gauges/'+gaugeId+'/deactivate-preview', { method:'POST', body:'{}' });
        const p = currentPreview;
        const recall = p.affected.filter(a => a.disposition === '退回校准');
        const risk = p.affected.filter(a => a.disposition === '标风险');
        $('#previewBody').innerHTML = '<p>量具 <b>'+esc(p.gauge.code)+' '+esc(p.gauge.name)+'</b>（有效期至 '+esc(p.gauge.validUntil)+'）停用后影响：</p>'+
          '<p class="warn">退回校准 '+recall.length+' 条（未交付，保留旧测量记录）：</p>'+recall.map(a => '<div>'+esc(a.itemCode)+' · '+esc(a.position)+' · 负责人 '+esc(a.owner)+'</div>').join('')+
          '<p class="warn">标风险 '+risk.length+' 条（已交付，只标记不改历史）：</p>'+risk.map(a => '<div>'+esc(a.itemCode)+' · '+esc(a.position)+' · 负责人 '+esc(a.owner)+'</div>').join('')+
          (p.affected.length === 0 ? '<p>无受影响帆索，可直接停用。</p>' : '');
        $('#previewMask').style.display = 'flex';
      } catch (e) { showMsg(e.message); }
    }
    $('#confirmDeact').onclick = async () => {
      if (!currentPreview) return;
      try {
        const r = await api('/api/gauges/'+currentPreview.gauge.id+'/deactivate-confirm', { method:'POST', body: JSON.stringify({ previewId: currentPreview.previewId, gaugeVersion: currentPreview.gaugeVersion }) });
        $('#previewMask').style.display = 'none';
        showMsg('复测批次 '+r.batch.id+' '+(r.deduplicated ? '已存在，重复确认未新建' : '已生成'), true);
        currentPreview = null;
        await load();
      } catch (e) { showMsg(e.message); $('#previewMask').style.display = 'none'; currentPreview = null; await load(); }
    };
    $('#cancelDeact').onclick = () => { $('#previewMask').style.display = 'none'; currentPreview = null; };
    async function load() {
      const s = await api('/api/state');
      items = s.items; gauges = s.gauges; batches = s.batches;
      renderSelects(); renderStats(); renderGauges(); renderBatches(); renderCards();
    }
    $('#createForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await load(); } catch (err) { showMsg(err.message); } };
    $('#actionForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/items/'+$('#itemSelect').value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await load(); } catch (err) { showMsg(err.message); } };
    $('#gaugeForm').onsubmit = async e => { e.preventDefault(); try { const g = await api('/api/gauges', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); showMsg('量具 '+g.code+' 已登记', true); await load(); } catch (err) { showMsg(err.message); } };
    $('#measureForm').onsubmit = async e => {
      e.preventDefault();
      try {
        await api('/api/items/'+$('#mItem').value+'/tasks/'+$('#mTask').value+'/measure', { method:'POST', body: JSON.stringify({ gaugeId: $('#mGauge').value, value: $('#mValue').value, note: $('#mNote').value }) });
        e.target.reset(); showMsg('测量已记录', true); await load();
      } catch (err) { showMsg(err.message); }
    };
    $('#reviewForm').onsubmit = async e => {
      e.preventDefault();
      try {
        await api('/api/items/'+$('#rItem').value+'/tasks/'+$('#rTask').value+'/review', { method:'POST', body: JSON.stringify({ result: $('#rResult').value, note: $('#rNote').value }) });
        e.target.reset(); showMsg('复核已记录', true); await load();
      } catch (err) { showMsg(err.message); }
    };
    $('#mItem').onchange = () => fillTasks($('#mItem'), $('#mTask'));
    $('#rItem').onchange = () => fillTasks($('#rItem'), $('#rTask'));
    ['statusFilter','gaugeFilter','riskFilter','ownerFilter'].forEach(id => $('#'+id).onchange = renderCards);
    $('#search').oninput = renderCards;
    $('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/state") {
      const db = await loadDb();
      return send(res, 200, {
        items: db.items.map(item => summarize(db, item)),
        gauges: db.gauges.map(g => ({ ...g, state: gaugeState(g) })),
        batches: db.batches.map(batchProgress),
        stats: computeStats(db.items)
      });
    }
    if (req.method === "GET" && url.pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(item => summarize(db, item)));
    }
    if (req.method === "GET" && url.pathname === "/api/gauges") {
      const db = await loadDb();
      return send(res, 200, db.gauges.map(g => ({ ...g, state: gaugeState(g) })));
    }
    if (req.method === "GET" && url.pathname === "/api/batches") {
      const db = await loadDb();
      return send(res, 200, db.batches.map(batchProgress));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, computeStats(db.items));
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = await withLock(async () => {
        const db = await loadDb();
        const item = { id: newId("MR"), ...input, tasks: [], logs: [{ at: nowIso(), step: "建档", note: "创建模型" }] };
        db.items.unshift(item);
        await saveDb(db);
        return item;
      });
      return send(res, 201, item);
    }

    if (req.method === "POST" && url.pathname === "/api/gauges") {
      const input = await body(req);
      const gauge = await withLock(async () => {
        const user = requireRole(req, ["计量员"]);
        const db = await loadDb();
        const code = String(input.code || "").trim();
        const name = String(input.name || "").trim();
        const validUntil = String(input.validUntil || "").trim();
        if (!code || !name) throw new HttpError(400, "invalid_gauge", "量具编号和名称必填");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new HttpError(400, "invalid_date", "有效期格式应为 YYYY-MM-DD");
        if (validUntil < today()) throw new HttpError(400, "invalid_date", "有效期不能早于今天");
        if (db.gauges.some(g => g.code === code)) throw new HttpError(409, "duplicate_code", "量具编号 " + code + " 已存在");
        const gauge = { id: newId("G"), code, name, validUntil, status: "在用", version: 1, registeredBy: user, registeredAt: nowIso(), history: [{ at: nowIso(), by: user, note: "登记量具，有效期至 " + validUntil }] };
        db.gauges.push(gauge);
        await saveDb(db);
        return gauge;
      });
      return send(res, 201, gauge);
    }

    const gaugePatch = url.pathname.match(/^\/api\/gauges\/([^/]+)$/);
    if (gaugePatch && req.method === "PATCH") {
      const input = await body(req);
      const gauge = await withLock(async () => {
        const user = requireRole(req, ["计量员"]);
        const db = await loadDb();
        const gauge = findGauge(db, gaugePatch[1]);
        if (!gauge) throw new HttpError(404, "gauge_not_found", "量具不存在");
        if (gauge.status === "停用") throw new HttpError(409, "deactivated", "量具已停用，不能再修改有效期");
        if (Number(input.version) !== gauge.version) {
          throw new HttpError(409, "version_conflict", "量具信息已变更（提交版本 " + (input.version === undefined ? "缺失" : "v" + input.version) + "，当前 v" + gauge.version + "），请刷新后重试");
        }
        const validUntil = String(input.validUntil || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new HttpError(400, "invalid_date", "有效期格式应为 YYYY-MM-DD");
        gauge.validUntil = validUntil;
        gauge.version += 1;
        gauge.history.push({ at: nowIso(), by: user, note: "有效期调整为 " + validUntil });
        await saveDb(db);
        return gauge;
      });
      return send(res, 200, gauge);
    }

    const deactPreview = url.pathname.match(/^\/api\/gauges\/([^/]+)\/deactivate-preview$/);
    if (deactPreview && req.method === "POST") {
      await body(req);
      const preview = await withLock(async () => {
        const user = requireRole(req, ["计量员"]);
        const db = await loadDb();
        const gauge = findGauge(db, deactPreview[1]);
        if (!gauge) throw new HttpError(404, "gauge_not_found", "量具不存在");
        if (gauge.status === "停用") throw new HttpError(409, "already_deactivated", "量具已停用，请勿重复操作");
        const affected = affectedByGauge(db, gauge.id).map(({ item, task }) => ({
          itemId: item.id, itemCode: item.code, taskId: task.id, position: task.position, owner: item.owner,
          disposition: item.status === "已交付" ? "标风险" : "退回校准"
        }));
        const preview = { id: newId("PV"), gaugeId: gauge.id, gaugeVersion: gauge.version, at: nowIso(), by: user, batchId: null };
        db.previews.push(preview);
        if (db.previews.length > 100) db.previews.splice(0, db.previews.length - 100);
        await saveDb(db);
        return { previewId: preview.id, gaugeVersion: gauge.version, gauge: { ...gauge, state: gaugeState(gauge) }, affected };
      });
      return send(res, 200, preview);
    }

    const deactConfirm = url.pathname.match(/^\/api\/gauges\/([^/]+)\/deactivate-confirm$/);
    if (deactConfirm && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const user = requireRole(req, ["计量员"]);
        const db = await loadDb();
        const gauge = findGauge(db, deactConfirm[1]);
        if (!gauge) throw new HttpError(404, "gauge_not_found", "量具不存在");
        const preview = db.previews.find(p => p.id === input.previewId && p.gaugeId === gauge.id);
        if (!preview) throw new HttpError(409, "preview_expired", "影响预览不存在或已过期，请重新预览后再确认");
        if (preview.batchId) {
          const existed = db.batches.find(b => b.id === preview.batchId);
          if (existed) return { batch: existed, deduplicated: true };
        }
        if (gauge.version !== Number(input.gaugeVersion) || preview.gaugeVersion !== gauge.version) {
          throw new HttpError(409, "version_conflict", "量具信息已变更（过期版本 v" + input.gaugeVersion + "，当前 v" + gauge.version + "），请重新预览");
        }
        if (gauge.status === "停用") {
          const open = db.batches.find(b => b.gaugeId === gauge.id && b.status === "复测中");
          if (open) return { batch: open, deduplicated: true };
          throw new HttpError(409, "already_deactivated", "量具已停用，请勿重复操作");
        }
        // 以下全部校验通过后才改动数据，最后一次落库，失败不留半批
        const now = nowIso();
        const batch = { id: newId("RB"), gaugeId: gauge.id, gaugeCode: gauge.code, gaugeName: gauge.name, createdAt: now, createdBy: user, status: "复测中", entries: [] };
        for (const { item, task } of affectedByGauge(db, gauge.id)) {
          if (item.status === "已交付") {
            batch.entries.push({ itemId: item.id, itemCode: item.code, taskId: task.id, position: task.position, owner: item.owner, disposition: "标风险", state: "已标记" });
            item.risks ||= [];
            item.risks.push({ batchId: batch.id, gaugeId: gauge.id, gaugeCode: gauge.code, note: "量具 " + gauge.code + " 已停用，交付记录存在风险", at: now });
            item.logs.push({ at: now, step: "风险", note: "量具 " + gauge.code + " 停用，批次 " + batch.id + " 标记风险（历史不变）" });
          } else {
            batch.entries.push({ itemId: item.id, itemCode: item.code, taskId: task.id, position: task.position, owner: item.owner, disposition: "退回校准", state: "待复测" });
            task.retest = { batchId: batch.id, state: "待复测" };
            item.status = "校准中";
            item.logs.push({ at: now, step: "复测", note: "量具 " + gauge.code + " 停用，退回校准（批次 " + batch.id + "），旧测量记录保留" });
          }
        }
        gauge.status = "停用";
        gauge.version += 1;
        gauge.deactivatedAt = now;
        gauge.deactivatedBy = user;
        gauge.history.push({ at: now, by: user, note: "停用，生成复测批次 " + batch.id });
        if (batch.entries.every(e => e.state === "已标记")) { batch.status = "已完成"; batch.completedAt = now; }
        preview.batchId = batch.id;
        db.batches.unshift(batch);
        await saveDb(db);
        return { batch, deduplicated: false };
      });
      return send(res, result.deduplicated ? 200 : 201, result);
    }

    const measure = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/measure$/);
    if (measure && req.method === "POST") {
      const input = await body(req);
      const item = await withLock(async () => {
        const user = requireRole(req, ["校准员"]);
        const db = await loadDb();
        const item = findItem(db, measure[1]);
        if (!item) throw new HttpError(404, "item_not_found", "模型不存在");
        const task = item.tasks.find(t => t.id === measure[2]);
        if (!task) throw new HttpError(404, "task_not_found", "帆索任务不存在");
        if (item.status === "已交付") throw new HttpError(409, "delivered", "项目已交付，不能再录入测量");
        const gauge = findGauge(db, String(input.gaugeId || ""));
        if (!gauge) throw new HttpError(404, "gauge_not_found", "量具不存在");
        if (gauge.status === "停用") throw new HttpError(409, "gauge_deactivated", "量具 " + gauge.code + " 已停用，不能用于测量");
        if (gauge.validUntil < today()) throw new HttpError(409, "gauge_expired", "量具 " + gauge.code + " 已过有效期（" + gauge.validUntil + "），不能用于测量");
        const value = String(input.value || "").trim();
        if (!value) throw new HttpError(400, "missing_value", "测量值必填");
        const open = task.retest && task.retest.state !== "已复核" ? task.retest : null;
        task.measurements.push({ id: newId("M"), at: nowIso(), gaugeId: gauge.id, gaugeCode: gauge.code, gaugeName: gauge.name, value, operator: user, note: String(input.note || ""), kind: open ? "复测" : "校准", batchId: open ? open.batchId : undefined });
        task.status = "已测量";
        if (open && open.state === "待复测") {
          open.state = "已复测";
          const batch = db.batches.find(b => b.id === open.batchId);
          const entry = batch && batch.entries.find(e => e.taskId === task.id);
          if (entry) entry.state = "已复测";
        }
        item.logs.push({ at: nowIso(), step: open ? "复测测量" : "测量", note: task.position + " · " + value + " · 量具 " + gauge.code + " · " + user });
        await saveDb(db);
        return summarize(db, item);
      });
      return send(res, 201, item);
    }

    const review = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const input = await body(req);
      const item = await withLock(async () => {
        const user = requireRole(req, ["复核员"]);
        const db = await loadDb();
        const item = findItem(db, review[1]);
        if (!item) throw new HttpError(404, "item_not_found", "模型不存在");
        const task = item.tasks.find(t => t.id === review[2]);
        if (!task) throw new HttpError(404, "task_not_found", "帆索任务不存在");
        if (!task.measurements.length) throw new HttpError(409, "no_measurement", "该帆索还没有测量记录，不能复核");
        const result = String(input.result || "");
        if (!["通过", "不通过"].includes(result)) throw new HttpError(400, "invalid_result", "复核结论只能是 通过/不通过");
        const open = task.retest && task.retest.state !== "已复核" ? task.retest : null;
        if (open && open.state === "待复测") throw new HttpError(409, "retest_pending", "请先由校准员完成复测测量再复核");
        const lastMeasurement = task.measurements[task.measurements.length - 1];
        if (task.lastReviewedMeasurementId === lastMeasurement.id) {
          throw new HttpError(409, "duplicate_review", "最后一次测量已有复核结论：批次完成后不接受重复结论，任务、批次和记录均不变；如有新问题请先重新测量再复核");
        }
        const now = nowIso();
        task.reviews.push({ at: now, reviewer: user, result, note: String(input.note || ""), batchId: open ? open.batchId : undefined, measurementId: lastMeasurement.id });
        task.lastReviewedMeasurementId = lastMeasurement.id;
        if (result === "通过") {
          task.status = "已复核";
          if (open) {
            open.state = "已复核";
            const batch = db.batches.find(b => b.id === open.batchId);
            const entry = batch && batch.entries.find(e => e.taskId === task.id);
            if (entry) entry.state = "已复核";
            if (batch && batch.entries.filter(e => e.disposition === "退回校准").every(e => e.state === "已复核")) {
              batch.status = "已完成";
              batch.completedAt = now;
              item.logs.push({ at: now, step: "复测", note: "批次 " + batch.id + " 复测完成，流程恢复" });
            }
          }
        } else {
          task.status = "调整中";
          if (open) {
            open.state = "待复测";
            const batch = db.batches.find(b => b.id === open.batchId);
            const entry = batch && batch.entries.find(e => e.taskId === task.id);
            if (entry) entry.state = "待复测";
          }
        }
        item.logs.push({ at: now, step: "复核", note: task.position + " · " + result + " · " + user });
        await saveDb(db);
        return summarize(db, item);
      });
      return send(res, 201, item);
    }

    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const input = await body(req);
      const item = await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, patch[1]);
        if (!item) throw new HttpError(404, "item_not_found", "模型不存在");
        const lock = itemLockBatch(db, item);
        if (lock && (input.status === "待复核" || input.status === "已交付")) {
          throw new HttpError(409, "locked", "批次 " + lock.id + " 复测未完成，暂不能推进到" + input.status);
        }
        Object.assign(item, input);
        item.logs.push({ at: nowIso(), step: "状态", note: "更新为" + item.status });
        await saveDb(db);
        return summarize(db, item);
      });
      return send(res, 200, item);
    }

    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      const item = await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, log[1]);
        if (!item) throw new HttpError(404, "item_not_found", "模型不存在");
        item.logs.push({ at: nowIso(), step: input.step || "记录", note: input.note || "" });
        await saveDb(db);
        return summarize(db, item);
      });
      return send(res, 201, item);
    }

    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const input = await body(req);
      const item = await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, action[1]);
        if (!item) throw new HttpError(404, "item_not_found", "模型不存在");
        item.tasks.push({ id: newId("T"), position: input.position, tension: input.tension, status: "待检查", measurements: [], reviews: [], logs: [{ at: nowIso(), note: input.note || "新增帆索任务" }] });
        item.status = "校准中";
        item.logs.push({ at: nowIso(), step: "帆索", note: input.position + " · " + input.tension });
        await saveDb(db);
        return summarize(db, item);
      });
      return send(res, 201, item);
    }

    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    sendError(res, error);
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
