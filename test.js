import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const PORT = 3199;
const DB = `/tmp/test-rigging-${process.pid}.json`;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? " -> " + JSON.stringify(extra) : "")); }
}
async function req(path, { method = "GET", role, user, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "x-role": encodeURIComponent(role || ""), "x-user": encodeURIComponent(user || "") },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json() };
}
function startServer() {
  const child = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: "pipe" });
  child.stderr.on("data", d => process.stderr.write(d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
    child.stdout.on("data", d => {
      if (String(d).includes("listening")) { clearTimeout(timer); resolve(child); }
    });
  });
}
async function stopServer(child) {
  child.kill("SIGTERM");
  await new Promise(r => child.on("exit", r));
}

let server;
try {
  await rm(DB, { force: true });
  server = await startServer();

  console.log("== 基础与越权 ==");
  let r = await req("/api/state");
  check("启动后 state 可用", r.status === 200 && Array.isArray(r.json.items));
  check("种子量具在用", r.json.gauges[0].state === "在用" && r.json.gauges[0].code === "TJ-01");

  r = await req("/api/gauges", { method: "POST", role: "校准员", user: "小李", body: { code: "TJ-02", name: "卡尺", validUntil: "2027-01-01" } });
  check("校准员登记量具被拒(403)", r.status === 403 && r.json.error === "forbidden");
  r = await req("/api/gauges", { method: "POST", role: "计量员", user: "", body: { code: "TJ-02", name: "卡尺", validUntil: "2027-01-01" } });
  check("缺操作人被拒(400)", r.status === 400);
  r = await req("/api/gauges", { method: "POST", role: "计量员", user: "王计量", body: { code: "TJ-02", name: "卡尺", validUntil: "2027-01-01" } });
  check("计量员登记量具成功", r.status === 201 && r.json.version === 1);
  const G2 = r.json.id;
  r = await req("/api/gauges", { method: "POST", role: "计量员", user: "王计量", body: { code: "TJ-02", name: "重复", validUntil: "2027-01-01" } });
  check("重复编号被拒(409)", r.status === 409);
  r = await req("/api/gauges", { method: "POST", role: "计量员", user: "王计量", body: { code: "TJ-03", name: "过期", validUntil: "2020-01-01" } });
  check("有效期早于今天被拒(400)", r.status === 400);

  console.log("== 测量与复核 ==");
  r = await req("/api/items", { method: "POST", body: { code: "A-1", shipType: "福船", owner: "周宁", status: "待检查" } });
  const itemA = r.json.id;
  r = await req(`/api/items/${itemA}/action`, { method: "POST", body: { position: "前桅侧支索", tension: "偏松" } });
  const taskA = r.json.tasks[0].id;
  r = await req(`/api/items/${itemA}/tasks/${taskA}/measure`, { method: "POST", role: "计量员", user: "王计量", body: { gaugeId: "G-1", value: "12.1N" } });
  check("计量员测量被拒(403)", r.status === 403);
  r = await req(`/api/items/${itemA}/tasks/${taskA}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: "G-1", value: "12.1N" } });
  check("校准员用有效量具测量成功", r.status === 201 && r.json.tasks[0].measurements[0].operator === "李校准");
  r = await req(`/api/items/${itemA}/tasks/${taskA}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: "NOPE", value: "1" } });
  check("不存在的量具被拒(404)", r.status === 404);
  r = await req(`/api/items/${itemA}/tasks/${taskA}/review`, { method: "POST", role: "校准员", user: "李校准", body: { result: "通过" } });
  check("校准员复核被拒(403)", r.status === 403);
  r = await req(`/api/items/${itemA}/tasks/${taskA}/review`, { method: "POST", role: "复核员", user: "赵复核", body: { result: "通过", note: "符合张力要求" } });
  check("复核员复核成功并留痕", r.status === 201 && r.json.tasks[0].reviews[0].reviewer === "赵复核");

  console.log("== 已交付项目 ==");
  r = await req("/api/items", { method: "POST", body: { code: "B-1", shipType: "沙船", owner: "陈帆", status: "待检查" } });
  const itemB = r.json.id;
  r = await req(`/api/items/${itemB}/action`, { method: "POST", body: { position: "主桅升帆索", tension: "偏紧" } });
  const taskB = r.json.tasks[0].id;
  await req(`/api/items/${itemB}/tasks/${taskB}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: "G-1", value: "9.8N" } });
  r = await req(`/api/items/${itemB}`, { method: "PATCH", body: { status: "已交付" } });
  check("B 项目交付", r.status === 200 && r.json.status === "已交付");
  r = await req(`/api/items/${itemB}/tasks/${taskB}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: "G-1", value: "9.9N" } });
  check("已交付项目再测量被拒(409)", r.status === 409);

  console.log("== 停用预览与确认 ==");
  r = await req("/api/gauges/G-1/deactivate-preview", { method: "POST", role: "校准员", user: "李校准" });
  check("非计量员预览被拒(403)", r.status === 403);
  r = await req("/api/gauges/G-1/deactivate-preview", { method: "POST", role: "计量员", user: "王计量" });
  check("影响预览返回两类处置", r.status === 200 && r.json.affected.length === 2 &&
    r.json.affected.some(a => a.disposition === "退回校准" && a.itemCode === "A-1") &&
    r.json.affected.some(a => a.disposition === "标风险" && a.itemCode === "B-1"), r.json);
  const previewId = r.json.previewId, gaugeVersion = r.json.gaugeVersion;

  r = await req("/api/gauges/G-1/deactivate-confirm", { method: "POST", role: "计量员", user: "王计量", body: { previewId, gaugeVersion: gaugeVersion + 99 } });
  check("过期版本确认被拒(409)", r.status === 409 && r.json.error === "version_conflict");
  r = await req("/api/batches");
  check("失败确认不留半批数据", r.status === 200 && r.json.length === 0);
  r = await req("/api/gauges");
  check("失败确认后量具仍在用", r.json.find(g => g.id === "G-1").status === "在用");

  r = await req("/api/gauges/G-1/deactivate-confirm", { method: "POST", role: "计量员", user: "王计量", body: { previewId, gaugeVersion } });
  check("确认生成唯一复测批次", r.status === 201 && r.json.batch.status === "复测中");
  const batchId = r.json.batch.id;
  r = await req("/api/gauges/G-1/deactivate-confirm", { method: "POST", role: "计量员", user: "王计量", body: { previewId, gaugeVersion } });
  check("重复确认复用原批次", r.status === 200 && r.json.deduplicated === true && r.json.batch.id === batchId);
  r = await req("/api/batches");
  check("批次仍然只有一个", r.json.length === 1);

  r = await req("/api/state");
  const a = r.json.items.find(i => i.code === "A-1");
  const b = r.json.items.find(i => i.code === "B-1");
  check("未交付项目退回校准", a.status === "校准中" && a.locked === true);
  check("旧测量记录保留", a.tasks[0].measurements.length === 1 && a.tasks[0].reviews.length === 1);
  check("已交付项目只标风险不改状态", b.status === "已交付" && b.risk && b.risk.batchId === batchId);
  check("量具已停用", r.json.gauges.find(g => g.id === "G-1").state === "停用");

  r = await req(`/api/items/${itemA}`, { method: "PATCH", body: { status: "待复核" } });
  check("复测中项目推进被拒(409)", r.status === 409 && r.json.error === "locked");
  r = await req(`/api/items/${itemA}/tasks/${taskA}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: "G-1", value: "12.5N" } });
  check("停用量具测量被拒(409)", r.status === 409 && r.json.error === "gauge_deactivated");
  r = await req("/api/gauges/G-1/deactivate-preview", { method: "POST", role: "计量员", user: "王计量" });
  check("已停用量具再预览被拒(409)", r.status === 409);

  console.log("== 复测闭环 ==");
  r = await req(`/api/items/${itemA}/tasks/${taskA}/review`, { method: "POST", role: "复核员", user: "赵复核", body: { result: "通过" } });
  check("未复测先复核被拒(409)", r.status === 409 && r.json.error === "retest_pending");
  r = await req(`/api/items/${itemA}/tasks/${taskA}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: G2, value: "12.5N", note: "换卡尺复测" } });
  check("复测测量成功", r.status === 201 && r.json.tasks[0].measurements[1].kind === "复测");
  r = await req(`/api/items/${itemA}/tasks/${taskA}/review`, { method: "POST", role: "复核员", user: "赵复核", body: { result: "不通过", note: "回退再测" } });
  check("复核不通过退回复测", r.status === 201 && r.json.tasks[0].retest.state === "待复测");
  await req(`/api/items/${itemA}/tasks/${taskA}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: G2, value: "12.4N" } });
  r = await req(`/api/items/${itemA}/tasks/${taskA}/review`, { method: "POST", role: "复核员", user: "赵复核", body: { result: "通过" } });
  check("复核通过完成复测", r.status === 201 && r.json.tasks[0].retest.state === "已复核");
  r = await req("/api/batches");
  check("批次自动完成", r.json[0].status === "已完成" && r.json[0].nextStep.includes("流程已恢复"));
  r = await req(`/api/items/${itemA}`, { method: "PATCH", body: { status: "待复核" } });
  check("复测完成后流程恢复", r.status === 200 && r.json.status === "待复核");

  console.log("== 过期量具 ==");
  r = await req(`/api/gauges/${G2}`, { method: "PATCH", role: "计量员", user: "王计量", body: { validUntil: "2020-01-01" } });
  check("计量员可调整有效期", r.status === 200 && r.json.version === 2);
  r = await req(`/api/items/${itemA}/tasks/${taskA}/measure`, { method: "POST", role: "校准员", user: "李校准", body: { gaugeId: G2, value: "1N" } });
  check("过期量具测量被拒(409)", r.status === 409 && r.json.error === "gauge_expired");
  r = await req(`/api/gauges/G-1`, { method: "PATCH", role: "计量员", user: "王计量", body: { validUntil: "2030-01-01" } });
  check("已停用量具改有效期被拒(409)", r.status === 409);

  console.log("== 重启持久化 ==");
  await stopServer(server);
  server = await startServer();
  r = await req("/api/state");
  const a2 = r.json.items.find(i => i.code === "A-1");
  const b2 = r.json.items.find(i => i.code === "B-1");
  check("重启后批次仍在", r.json.batches.length === 1 && r.json.batches[0].status === "已完成");
  check("重启后量具状态仍在", r.json.gauges.find(g => g.id === "G-1").state === "停用");
  check("重启后测量与复核记录仍在", a2.tasks[0].measurements.length === 3 && a2.tasks[0].reviews.length === 3);
  check("重启后风险标记仍在", b2.risk && b2.risk.batchId === batchId);
  await stopServer(server);
} catch (e) {
  failed++;
  console.error("ERROR", e);
  if (server) await stopServer(server).catch(() => {});
} finally {
  await rm(DB, { force: true }).catch(() => {});
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
