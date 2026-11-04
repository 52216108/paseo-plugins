import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { buildState, type AgentLite, type HostData } from "../server/summary.ts";
import { applyRegister, applyResult, decide, newDevice, settleIdle, ORPHAN_RESTART_MS, ROTATE_AFTER_MS, START_COOLDOWN_MS, REFRESH_MS, type Device } from "../server/decide.ts";
import { signJwt, validateKey, loadPrivateKey, ApnsClient, requestHeaders } from "../server/apns.ts";
import { alertsEnabled, alertTargets, buildAlertPayload, checkAlert, scanAlerts, ALERT_MAX_AGE_MS, type NotifiedMap } from "../server/notify.ts";
import { activityRegister, registerInput } from "../shared/contracts.ts";
import { toLite } from "../server/summary.ts";
import { buildNotificationPreview, buildPermissionDetails, findLatestAssistantMessageFromTimeline, latestReplyFromEntries, stripMarkdownToText } from "../server/preview.ts";
import { Store } from "../server/store.ts";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T0 = Date.parse("2026-11-04T10:00:00Z");
let seq = 0;
function agent(over: Partial<AgentLite> = {}): AgentLite {
  seq++;
  return {
    id: over.id ?? `a${seq}`, title: `会话${seq}`, status: "idle", pendingPermissions: [], activeTurn: null,
    labels: {}, archivedAt: null, attentionReason: null, updatedAt: new Date(T0 - seq * 1000).toISOString(), ...over,
  };
}
function host(serverId: string, label: string, agents: AgentLite[] | null): HostData {
  return { host: { serverId, label }, agents: agents ? new Map(agents.map(a => [a.id, a])) : null };
}
function device(over: Partial<Device> = {}): Device {
  return {
    deviceId: "dev1", bundleId: "com.example.app", environment: "development",
    pushToStartToken: "aa".repeat(32), activityToken: null, alertToken: null, hosts: [{ serverId: "s1", label: "Mac" }],
    activityStartedAt: null, lastStartAt: null, lastSent: null, lastSentWaiting: 0, ...over,
  };
}

test("嵌套子会话被过滤，跨机器父会话或父会话不存在时保留", () => {
  const parent = agent({ id: "p", status: "running" });
  const child = agent({ id: "c", status: "running", labels: { "paseo.parent-agent-id": "p" } });
  const childSameServer = agent({ id: "c2", status: "running", labels: { "paseo.parent-agent-id": "p", "paseo.parent-server-id": "s1" } });
  const childOtherServer = agent({ id: "c3", status: "running", labels: { "paseo.parent-agent-id": "p", "paseo.parent-server-id": "s9" } });
  const orphan = agent({ id: "c4", status: "running", labels: { "paseo.parent-agent-id": "gone" } });
  const state = buildState([host("s1", "Mac", [parent, child, childSameServer, childOtherServer, orphan])], 1);
  assert.equal(state.running, 3);
  assert.deepEqual(state.rows.map(r => r.agentId).sort(), ["c3", "c4", "p"]);
});

test("分类优先级：权限 > 出错 > 运行中，归档与空闲忽略", () => {
  const state = buildState([host("s1", "Mac", [
    agent({ id: "w1", status: "error", pendingPermissions: [{}] }),
    agent({ id: "w2", status: "running", attentionReason: "permission" }),
    agent({ id: "f1", status: "running", attentionReason: "error" }),
    agent({ id: "f2", status: "error" }),
    agent({ id: "r1", status: "running" }),
    agent({ id: "x1", status: "running", archivedAt: "2026-11-01T00:00:00Z" }),
    agent({ id: "i1", status: "idle", attentionReason: "finished" }),
  ])], 1);
  assert.deepEqual([state.waiting, state.failed, state.running], [2, 2, 1]);
  const byId = Object.fromEntries(state.rows.map(r => [r.agentId, r.status]));
  assert.equal(byId.w1, "waiting");
  assert.equal(byId.w2, "waiting");
  assert.equal(byId.f1, "failed");
});

test("排序截断：waiting → failed → running，同类新的在前，最多 4 条；离线机器进 offline", () => {
  const started = "2026-11-04T09:00:00.000Z";
  const state = buildState([
    host("s1", "Studio", [
      agent({ id: "r-old", status: "running", updatedAt: "2026-11-04T08:00:00Z", activeTurn: { turnId: "t", startedAt: started } }),
      agent({ id: "r-new", status: "running", updatedAt: "2026-11-04T09:30:00Z", title: "" }),
      agent({ id: "f", status: "error", updatedAt: "2026-11-04T07:00:00Z" }),
    ]),
    host("s2", "mini", [agent({ id: "w", status: "running", pendingPermissions: [{}], updatedAt: "2026-11-04T06:00:00Z" }),
      agent({ id: "r-mid", status: "running", updatedAt: "2026-11-04T09:00:00Z" })]),
    host("s3", "Laptop", null),
  ], 123.5);
  assert.deepEqual(state.rows.map(r => r.agentId), ["w", "f", "r-new", "r-mid"]);
  assert.equal(state.rows[0].host, "mini");
  assert.equal(state.rows[2].title, "新会话");
  assert.equal(state.rows[0].since, undefined);
  assert.equal(state.rows[1].since, undefined);
  assert.deepEqual(state.offline, ["Laptop"]);
  assert.equal(state.updatedAt, 123.5);
  // running 行带 since（本回合开始时间，秒）
  const one = buildState([host("s1", "Mac", [agent({ status: "running", activeTurn: { turnId: "t", startedAt: started } })])], 1);
  assert.equal(one.rows[0].since, Date.parse(started) / 1000);
});

test("只有出错、没有运行或等待时 rows 为空", () => {
  const state = buildState([host("s1", "Mac", [agent({ status: "error" })])], 1);
  assert.equal(state.failed, 1);
  assert.deepEqual(state.rows, []);
});

const running = (n = 1) => buildState([host("s1", "Mac", Array.from({ length: n }, () => agent({ status: "running" })))], T0 / 1000);
const idle = () => buildState([host("s1", "Mac", [agent()])], T0 / 1000);

test("活跃且无 activityToken：推 start 到 push-to-start，带 attributes 与 alert；2 分钟内不重复", () => {
  const d = device();
  const [step, ...rest] = decide(d, running(2), T0);
  assert.equal(rest.length, 0);
  assert.equal(step.kind, "start");
  assert.equal(step.tokenKind, "pushToStart");
  assert.equal(step.priority, 10);
  const aps = step.payload.aps;
  assert.equal(aps.event, "start");
  assert.equal(aps["attributes-type"], "PaseoActivityAttributes");
  assert.deepEqual(aps.attributes, {});
  assert.deepEqual(aps.alert, { title: "Paseo", body: "2 个会话运行中" });
  assert.equal(aps.timestamp, T0 / 1000);
  assert.equal(aps["stale-date"], T0 / 1000 + 900);
  applyResult(d, step, { ok: true, status: 200, reason: null }, T0);
  assert.equal(d.lastStartAt, T0);
  assert.equal(d.activityStartedAt, T0);
  assert.deepEqual(decide(d, running(3), T0 + START_COOLDOWN_MS - 1), []);
  // start 成功但令牌一直没报回来：不每 2 分钟重发，1 小时后才再试。
  assert.deepEqual(decide(d, running(3), T0 + START_COOLDOWN_MS), []);
  assert.equal(decide(d, running(3), T0 + ORPHAN_RESTART_MS)[0].kind, "start");
});

test("start 失败：2 分钟后重试", () => {
  const d = device();
  const [step] = decide(d, running(1), T0);
  applyResult(d, step, { ok: false, status: 500, reason: "InternalServerError" }, T0);
  assert.deepEqual(decide(d, running(1), T0 + START_COOLDOWN_MS - 1), []);
  assert.equal(decide(d, running(1), T0 + START_COOLDOWN_MS)[0].kind, "start");
});

test("轮换时 end 成功、start 失败：2 分钟后重试，不当成令牌没报回", () => {
  const d = device({ activityToken: "ab".repeat(32), activityStartedAt: T0 - ROTATE_AFTER_MS });
  const [end, start] = decide(d, running(1), T0);
  assert.equal(end.kind, "end");
  assert.equal(start.kind, "start");
  applyResult(d, end, { ok: true, status: 200, reason: null }, T0);
  applyResult(d, start, { ok: false, status: 429, reason: "TooManyRequests" }, T0);
  assert.equal(decide(d, running(1), T0 + START_COOLDOWN_MS)[0].kind, "start");
});

test("没有令牌时全部结束：归为空闲，下次有会话开始立刻 start", () => {
  const d = device();
  const [step] = decide(d, running(1), T0);
  applyResult(d, step, { ok: true, status: 200, reason: null }, T0);
  assert.equal(settleIdle(d, idle(), T0 + 1000), true);
  assert.equal(settleIdle(d, idle(), T0 + 2000), false);
  assert.equal(decide(d, running(1), T0 + 3000)[0].kind, "start");
});

test("活跃且有 activityToken：内容变化推 update（priority 5），未变化不推，10 分钟保活", () => {
  const d = device({ activityToken: "bb".repeat(32), activityStartedAt: T0 });
  const state = running(1);
  const [step] = decide(d, state, T0);
  assert.equal(step.kind, "update");
  assert.equal(step.priority, 5);
  assert.equal(step.payload.aps.alert, undefined);
  applyResult(d, step, { ok: true, status: 200, reason: null }, T0);
  assert.deepEqual(decide(d, { ...state, updatedAt: state.updatedAt + 5 }, T0 + 1000), []);
  assert.equal(decide(d, state, T0 + REFRESH_MS)[0].kind, "update");
});

test("waiting 变多：priority 10 并带「需要你处理」提醒", () => {
  const d = device({ activityToken: "bb".repeat(32), activityStartedAt: T0 });
  const state = buildState([host("s1", "Mac", [agent({ status: "running", title: "修登录页", pendingPermissions: [{}] })])], T0 / 1000);
  const [step] = decide(d, state, T0);
  assert.equal(step.priority, 10);
  assert.deepEqual(step.payload.aps.alert, { title: "需要你处理", body: "修登录页", sound: "default" });
  applyResult(d, step, { ok: true, status: 200, reason: null }, T0);
  // waiting 没再变多：回到 priority 5
  const [again] = decide(d, running(1), T0 + 1000);
  assert.equal(again.priority, 5);
});

test("不活跃且有 activityToken：推 end（dismissal-date +300），成功后清掉令牌；无令牌不推", () => {
  const d = device({ activityToken: "bb".repeat(32), activityStartedAt: T0 });
  const [step] = decide(d, idle(), T0);
  assert.equal(step.kind, "end");
  assert.equal(step.priority, 10);
  assert.equal(step.payload.aps["dismissal-date"], T0 / 1000 + 300);
  assert.equal((step.payload.aps["content-state"] as { running: number }).running, 0);
  applyResult(d, step, { ok: true, status: 200, reason: null }, T0);
  assert.equal(d.activityToken, null);
  assert.deepEqual(decide(d, idle(), T0 + 1000), []);
});

test("活动满 7 小时 45 分：先 end 再 start", () => {
  const d = device({ activityToken: "bb".repeat(32), activityStartedAt: T0 - ROTATE_AFTER_MS });
  const steps = decide(d, running(1), T0);
  assert.deepEqual(steps.map(s => s.kind), ["end", "start"]);
  assert.equal(steps[0].payload.aps["dismissal-date"], T0 / 1000);
});

test("APNs 410 / BadDeviceToken 清除对应令牌，其他错误保留", () => {
  const d = device({ activityToken: "bb".repeat(32) });
  const [update] = decide(d, running(1), T0);
  applyResult(d, update, { ok: false, status: 500, reason: "InternalServerError" }, T0);
  assert.equal(d.activityToken, "bb".repeat(32));
  applyResult(d, update, { ok: false, status: 410, reason: "Unregistered" }, T0);
  assert.equal(d.activityToken, null);
  const [start] = decide(d, running(1), T0);
  applyResult(d, start, { ok: false, status: 400, reason: "BadDeviceToken" }, T0);
  assert.equal(d.pushToStartToken, null);
});

test("JWT：ES256 签名可验证，非法密钥报中文错误且不回显内容", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = signJwt(loadPrivateKey(pem), "TEAM123456", "KEY1234567", T0);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url").toString()), { iss: "TEAM123456", iat: T0 / 1000 });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.equal(validateKey({ teamId: "TEAM123456", keyId: "KEY1234567", p8: pem }).keyId, "KEY1234567");
  assert.throws(() => validateKey({ teamId: "TEAM123456", keyId: "KEY1234567", p8: "SECRET-NOT-PEM" }), (e: Error) => /无法解析/.test(e.message) && !e.message.includes("SECRET"));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => validateKey({ teamId: "TEAM123456", keyId: "KEY1234567", p8: rsa }), /P-256/);
});

test("密钥按环境保存：旧格式当两个环境都用，新格式各管各的，文件 0600", async () => {
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dev = { teamId: "TEAM123456", keyId: "DEVKEY1234", p8: pem };
  const dir = mkdtempSync(join(tmpdir(), "la-store-"));
  const store = new Store(dir);
  writeFileSync(join(dir, "apns-key.json"), JSON.stringify(dev));
  const legacy = await store.loadKeys();
  assert.equal(legacy.development?.keyId, "DEVKEY1234");
  assert.equal(legacy.production?.keyId, "DEVKEY1234");
  await store.saveKeys({ development: dev });
  const only = await store.loadKeys();
  assert.equal(only.development?.keyId, "DEVKEY1234");
  assert.equal(only.production, undefined);
  assert.equal(JSON.parse(readFileSync(join(dir, "apns-key.json"), "utf8")).version, 2);
  assert.equal(statSync(join(dir, "apns-key.json")).mode & 0o777, 0o600);
  const client = new ApnsClient();
  client.setKeys(only);
  assert.equal(client.configuredFor("development"), true);
  assert.equal(client.configuredFor("production"), false);
  const result = await client.send("production", "ab".repeat(32), "com.example.app", 5, {});
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /未配置 production/);
  client.close();
});

test("行里带工作区名：优先工作区显示名，没有就用目录名", () => {
  const a = agent({ status: "running", workspaceId: "w1", cwd: "/Users/x/projects/foo" });
  const b = agent({ status: "running", workspaceId: "w-unknown", cwd: "/Users/x/projects/bar/" });
  const c = agent({ status: "running" });
  const h: HostData = { host: { serverId: "s1", label: "Mac" }, agents: new Map([a, b, c].map(x => [x.id, x])), workspaces: new Map([["w1", { project: "订个包间工作区", title: null }]]) };
  const rows = buildState([h], T0 / 1000).rows;
  const byId = new Map(rows.map(r => [r.agentId, r]));
  assert.equal(byId.get(a.id)?.project, "订个包间工作区");
  assert.equal(byId.get(b.id)?.project, "bar");
  assert.equal("project" in (byId.get(c.id) ?? {}), false);
});

test("按工作区合并：一个工作区一行，状态取最紧急的，计数按工作区，行名用工作区标题", () => {
  const ws = new Map([["w1", { project: "订个包间工作区", title: "检查安卓店小助绘画阴影" }], ["w2", { project: "宴小助工作区", title: null }]]);
  const run1 = agent({ status: "running", workspaceId: "w1", activeTurn: { turnId: "t1", startedAt: new Date(T0 - 600_000).toISOString() } });
  const run2 = agent({ status: "running", workspaceId: "w1", activeTurn: { turnId: "t2", startedAt: new Date(T0 - 60_000).toISOString() } });
  const wait = agent({ status: "running", workspaceId: "w2", pendingPermissions: [{}], title: "迁移数据" });
  const run3 = agent({ status: "running", workspaceId: "w2" });
  const h: HostData = { host: { serverId: "s1", label: "Mac" }, agents: new Map([run1, run2, wait, run3].map(x => [x.id, x])), workspaces: ws };
  const st = buildState([h], T0 / 1000);
  assert.equal(st.rows.length, 2);
  assert.equal(st.running, 1);
  assert.equal(st.waiting, 1);
  assert.equal(st.rows[0].status, "waiting");
  assert.equal(st.rows[0].agentId, wait.id);
  assert.equal(st.rows[0].title, "迁移数据");
  assert.equal(st.rows[0].project, "宴小助工作区");
  assert.equal("since" in st.rows[0], false);
  assert.equal(st.rows[1].title, "检查安卓店小助绘画阴影");
  assert.equal(st.rows[1].project, "订个包间工作区");
  assert.equal(st.rows[1].since, (T0 - 600_000) / 1000);
});

// ---------- 普通通知 ----------

const iso = (ms: number) => new Date(ms).toISOString();
const attn = (reason: string, at: number, over: Partial<AgentLite> = {}) =>
  agent({ requiresAttention: true, attentionReason: reason, attentionTimestamp: iso(at), ...over });

test("通知判定：基线不发，时间戳变化才发，同一时间戳只发一次", () => {
  const notified: NotifiedMap = new Map();
  const a = attn("finished", T0 - 1000, { id: "n1" });
  const list = new Map([[a.id, a]]);
  // 全量快照只建基线（即使在 120 秒内）
  assert.deepEqual(scanAlerts(list, "s1", notified, T0, true), []);
  assert.equal(checkAlert(a, "s1", list, notified, T0), null);
  // 新时间戳 → 发一次
  const b = { ...a, attentionTimestamp: iso(T0 - 500) };
  const ev = checkAlert(b, "s1", list, notified, T0);
  assert.equal(ev?.reason, "finished");
  assert.equal(ev?.timestamp, iso(T0 - 500));
  assert.equal(checkAlert(b, "s1", list, notified, T0 + 10), null);
  // 不需要提醒 / 原因不在范围内不发
  assert.equal(checkAlert({ ...a, attentionTimestamp: iso(T0 - 100), requiresAttention: false }, "s1", list, notified, T0), null);
  assert.equal(checkAlert({ ...a, attentionTimestamp: iso(T0 - 90), attentionReason: null }, "s1", list, notified, T0), null);
});

test("通知判定：超过 120 秒不发；子会话、归档不发", () => {
  const notified: NotifiedMap = new Map();
  const old = attn("error", T0 - ALERT_MAX_AGE_MS, { id: "old" });
  const parent = agent({ id: "par" });
  const child = agent({ id: "kid", labels: { "paseo.parent-agent-id": "par" }, pendingPermissions: [{ id: "rk" }] });
  const archived = attn("finished", T0 - 1000, { id: "arc", archivedAt: iso(T0) });
  const list = new Map([old, parent, child, archived].map(x => [x.id, x]));
  for (const x of [old, child, archived]) assert.equal(checkAlert(x, "s1", list, notified, T0), null);
  // 刚好 120 秒内的会发
  const fresh = attn("error", T0 - ALERT_MAX_AGE_MS + 1, { id: "fresh" });
  assert.equal(checkAlert(fresh, "s1", list, notified, T0)?.reason, "error");
});

test("轮询：只有第一份列表是基线，之后与上一份对比", () => {
  const notified: NotifiedMap = new Map();
  const a = agent({ id: "p1" });
  assert.deepEqual(scanAlerts(new Map([[a.id, a]]), "s1", notified, T0, true), []);
  const b = agent({ id: "p1", pendingPermissions: [{ id: "r1", title: "运行 npm test" }] });
  const events = scanAlerts(new Map([[b.id, b]]), "s1", notified, T0, false);
  assert.deepEqual(events.map(e => e.agent.id), ["p1"]);
  assert.deepEqual(scanAlerts(new Map([[b.id, b]]), "s1", notified, T0 + 30_000, false), []);
  // 不在列表里的从记录里去掉
  scanAlerts(new Map(), "s1", notified, T0, false);
  assert.equal(notified.size, 0);
});

test("载荷：三种 reason 的 title / body / category，thread-id 与顶层 serverId / agentId", () => {
  const ws = new Map([["w1", { project: "宴小助", title: "修登录页" }]]);
  const perm = toLite({ ...agent({ id: "ag1", title: "迁移数据" }), pendingPermissions: [{ title: "运行 npm test", name: "Bash", kind: "tool", input: { big: "x" } }] } as unknown as AgentLite);
  assert.equal("input" in perm.pendingPermissions[0], false);
  const p = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: perm, reason: "permission" });
  assert.deepEqual(p, {
    aps: { alert: { title: "需要你批准 · 迁移数据", body: "运行 npm test" }, sound: "default", category: "paseo.permission", "thread-id": "s1:ag1" },
    serverId: "s1", agentId: "ag1", reason: "permission",
  });
  const byName = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: { ...perm, pendingPermissions: [{ name: "Bash" }] }, reason: "permission" });
  assert.equal(byName.aps.alert.body, "Bash");
  assert.equal(buildAlertPayload({ serverId: "s1", hostLabel: "S", agent: { ...perm, pendingPermissions: [] }, reason: "permission" }).aps.alert.body, "有一个权限请求等你处理");

  const longError = "错".repeat(300);
  const err = toLite({ ...agent({ id: "ag2", title: "" }), lastError: longError } as AgentLite);
  const e = buildAlertPayload({ serverId: "s2", hostLabel: "mini", agent: err, reason: "error" });
  assert.equal(e.aps.alert.title, "出错了 · 会话");
  assert.equal(e.aps.alert.body, "错".repeat(200));
  assert.equal(e.aps.category, "paseo.finished");
  assert.equal(buildAlertPayload({ serverId: "s2", hostLabel: "mini", agent: { ...err, lastError: null }, reason: "error" }).aps.alert.body, "会话出错");

  const fin = agent({ id: "ag3", title: "写文档", workspaceId: "w1" });
  const f = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: fin, reason: "finished", workspaces: ws });
  // 主标题用工作区名（侧栏行名），没有副标题；取不到最后回复时正文是项目名 · 机器名
  assert.equal(f.aps.alert.title, "完成 · 修登录页");
  assert.equal("subtitle" in f.aps.alert, false);
  assert.equal(f.aps.alert.body, "宴小助 · Studio");
  assert.equal(f.aps.category, "paseo.finished");
  assert.equal(f.aps["thread-id"], "s1:ag3");
  assert.equal(buildAlertPayload({ serverId: "s1", hostLabel: "S", agent: agent({ cwd: "/x/foo" }), reason: "finished" }).aps.alert.body, "foo · S");
  assert.equal(buildAlertPayload({ serverId: "s1", hostLabel: "", agent: agent(), reason: "finished" }).aps.alert.body, "回合已结束");
});

test("请求头：alert 用 bundleId 作 topic、优先级 10、collapse-id 超 64 字节省略；灵动岛不变", () => {
  const h = requestHeaders("ab".repeat(32), "jwt", "com.example.app", 10, 42, { pushType: "alert", collapseId: "agent-1" });
  assert.equal(h["apns-push-type"], "alert");
  assert.equal(h["apns-topic"], "com.example.app");
  assert.equal(h["apns-priority"], "10");
  assert.equal(h["apns-collapse-id"], "agent-1");
  assert.equal(requestHeaders("ab", "jwt", "com.example.app", 10, 1, { pushType: "alert", collapseId: "x".repeat(65) })["apns-collapse-id"], undefined);
  assert.equal(requestHeaders("ab", "jwt", "com.example.app", 10, 1, { pushType: "alert", collapseId: "x".repeat(64) })["apns-collapse-id"], "x".repeat(64));
  const la = requestHeaders("ab", "jwt", "com.example.app", 5, 1);
  assert.equal(la["apns-push-type"], "liveactivity");
  assert.equal(la["apns-topic"], "com.example.app.push-type.liveactivity");
  assert.equal("apns-collapse-id" in la, false);
});

test("alertToken：省略 = 保持、null = 清除、校验转小写；旧记录按 null 读；目标设备与 alerts 输出", async () => {
  const base = { deviceId: "d1", bundleId: "com.example.app", environment: "production" as const, hosts: [{ serverId: "s1", label: "Studio" }] };
  const d = applyRegister(newDevice(base), registerInput.parse({ ...base, alertToken: "AB".repeat(32) }), T0);
  assert.equal(d.alertToken, "ab".repeat(32));
  applyRegister(d, registerInput.parse({ ...base, activityToken: "cd".repeat(32) }), T0);
  assert.equal(d.alertToken, "ab".repeat(32));
  applyRegister(d, registerInput.parse({ ...base, alertToken: null }), T0);
  assert.equal(d.alertToken, null);
  assert.throws(() => registerInput.parse({ ...base, alertToken: "zz" }));

  const dir = mkdtempSync(join(tmpdir(), "la-dev-"));
  writeFileSync(join(dir, "devices.json"), JSON.stringify({ version: 1, devices: [{ deviceId: "old", bundleId: "b", environment: "production", hosts: [] }] }));
  assert.equal((await new Store(dir).loadDevices())[0].alertToken, null);

  const withToken = device({ alertToken: "ef".repeat(32), environment: "production", hosts: [{ serverId: "s1", label: "Studio" }] });
  const other = device({ deviceId: "d2", alertToken: "ef".repeat(32), hosts: [{ serverId: "s9", label: "x" }] });
  const none = device({ deviceId: "d3" });
  assert.deepEqual(alertTargets([withToken, other, none], "s1").map(t => [t.device.deviceId, t.hostLabel]), [["dev1", "Studio"]]);
  assert.equal(alertsEnabled(withToken, env => env === "production"), true);
  assert.equal(alertsEnabled(withToken, () => false), false);
  assert.equal(alertsEnabled(none, () => true), false);
  assert.deepEqual(activityRegister.output.parse({ configured: true, serverId: "s1", alerts: false }), { configured: true, serverId: "s1", alerts: false });
});

test("有 alertToken 时灵动岛 waiting 增加的 update 仍 priority 10 但不带 alert；start 仍带 alert", () => {
  const state = buildState([host("s1", "Mac", [agent({ status: "running", title: "修登录页", pendingPermissions: [{}] })])], T0 / 1000);
  const d = device({ activityToken: "bb".repeat(32), activityStartedAt: T0, alertToken: "ef".repeat(32) });
  const [step] = decide(d, state, T0);
  assert.equal(step.kind, "update");
  assert.equal(step.priority, 10);
  assert.equal(step.payload.aps.alert, undefined);
  const [start] = decide(device({ alertToken: "ef".repeat(32) }), state, T0);
  assert.equal(start.kind, "start");
  assert.deepEqual(start.payload.aps.alert, { title: "需要你处理", body: "修登录页", sound: "default" });
});

test("需要批准按新出现的待批准请求判定（daemon 不为权限请求设置 attention）", () => {
  const notified: NotifiedMap = new Map();
  const idle = agent({ id: "q1", status: "running" });
  const list = new Map([[idle.id, idle]]);
  scanAlerts(list, "s1", notified, T0, true);
  // 只有 attentionReason=permission、没有待批准请求：不按权限发（真实 daemon 不会这样，旧记录遗留）
  assert.equal(checkAlert(attn("permission", T0 - 1000, { id: "q1" }), "s1", list, notified, T0), null);
  const one = agent({ id: "q1", status: "running", pendingPermissions: [{ id: "r1", title: "运行 npm test" }] });
  const e1 = checkAlert(one, "s1", list, notified, T0);
  assert.equal(e1?.reason, "permission");
  assert.equal(e1?.timestamp, "perm:r1");
  // 同一请求再来一次 upsert 不重复
  assert.equal(checkAlert(one, "s1", list, notified, T0 + 1000), null);
  // 又多了一个新请求：再发
  const two = agent({ id: "q1", status: "running", pendingPermissions: [{ id: "r1" }, { id: "r2" }] });
  assert.equal(checkAlert(two, "s1", list, notified, T0 + 2000)?.timestamp, "perm:r2");
  // 请求被处理掉后完成：按完成发
  const done = attn("finished", T0 + 3000, { id: "q1" });
  assert.equal(checkAlert(done, "s1", list, notified, T0 + 3500)?.reason, "finished");
  // 基线里已有的待批准请求不发
  const n2: NotifiedMap = new Map();
  scanAlerts(new Map([[one.id, one]]), "s1", n2, T0, true);
  assert.equal(checkAlert(one, "s1", list, n2, T0), null);
});

test("需要批准的通知带上对应请求 id，正文取那个请求", () => {
  const a = toLite({ ...agent({ id: "ag9", title: "迁移" }), pendingPermissions: [{ id: "r1", title: "旧请求" }, { id: "r2", title: "运行 npm test" }] } as unknown as AgentLite);
  const p = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: a, reason: "permission", requestId: "r2" });
  assert.equal(p.requestId, "r2");
  assert.equal(p.aps.alert.body, "运行 npm test");
  const f = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: a, reason: "finished" });
  assert.equal("requestId" in f, false);
});

// ---------- 嵌套子会话计入工作区状态 ----------

const PARENT = "paseo.parent-agent-id";

test("主会话空闲、子会话运行中：工作区一行 running，点开子会话，行名用工作区标题 / 顶层会话标题", () => {
  const started = iso(T0 - 300_000);
  const root = agent({ id: "root", title: "主会话", workspaceId: "w1", updatedAt: iso(T0 - 50_000) });
  const kid = agent({ id: "kid", title: "子会话", workspaceId: "w1", status: "running", labels: { [PARENT]: "root" },
    activeTurn: { turnId: "t", startedAt: started }, updatedAt: iso(T0 - 1000) });
  const ws = new Map([["w1", { project: "宴小助", title: "修登录页" }]]);
  const h: HostData = { host: { serverId: "s1", label: "Mac" }, agents: new Map([root, kid].map(x => [x.id, x])), workspaces: ws };
  const st = buildState([h], T0 / 1000);
  assert.equal(st.running, 1);
  assert.deepEqual(st.rows, [{ serverId: "s1", agentId: "kid", host: "Mac", title: "修登录页", project: "宴小助", status: "running", since: Date.parse(started) / 1000 }]);
  // 没有工作区标题：用顶层会话标题，不用子会话标题
  const noTitle = buildState([{ ...h, workspaces: new Map([["w1", { project: "宴小助", title: null }]]) }], T0 / 1000);
  assert.equal(noTitle.rows[0].title, "主会话");
  // 子会话 updatedAt 参与排序
  const other = agent({ id: "other", status: "running", updatedAt: iso(T0 - 20_000) });
  const order = buildState([{ ...h, agents: new Map([root, kid, other].map(x => [x.id, x])) }], T0 / 1000);
  assert.deepEqual(order.rows.map(r => r.agentId), ["kid", "other"]);
});

test("子会话等你处理 → 工作区 waiting；子会话出错不让工作区变 failed", () => {
  const root = agent({ id: "r1", workspaceId: "w1", status: "running" });
  const waitKid = agent({ id: "k1", workspaceId: "w1", labels: { [PARENT]: "r1" }, pendingPermissions: [{ id: "p" }] });
  const st = buildState([host("s1", "Mac", [root, waitKid])], T0 / 1000);
  assert.deepEqual([st.waiting, st.running], [1, 0]);
  assert.equal(st.rows[0].agentId, "k1");
  assert.equal(st.rows[0].status, "waiting");
  assert.equal("since" in st.rows[0], false);

  const idleRoot = agent({ id: "r2", workspaceId: "w2" });
  const failKid = agent({ id: "k2", workspaceId: "w2", status: "error", labels: { [PARENT]: "r2" } });
  const st2 = buildState([host("s1", "Mac", [idleRoot, failKid])], T0 / 1000);
  assert.deepEqual([st2.failed, st2.running, st2.waiting], [0, 0, 0]);
  // 顶层会话运行中 + 子会话出错：仍是 running，点开顶层会话
  const st3 = buildState([host("s1", "Mac", [{ ...idleRoot, status: "running" }, failKid])], T0 / 1000);
  assert.deepEqual([st3.failed, st3.running], [0, 1]);
  assert.equal(st3.rows[0].agentId, "r2");
});

test("孙会话也计入；父已归档时子会话当顶层；跨机器父会话不算嵌套", () => {
  const root = agent({ id: "g0", workspaceId: "w1" });
  const mid = agent({ id: "g1", workspaceId: "w1", labels: { [PARENT]: "g0" } });
  const leaf = agent({ id: "g2", workspaceId: "w1", status: "running", labels: { [PARENT]: "g1", "paseo.parent-server-id": "s1" } });
  const st = buildState([host("s1", "Mac", [root, mid, leaf])], T0 / 1000);
  assert.equal(st.running, 1);
  assert.deepEqual(st.rows.map(r => r.agentId), ["g2"]);

  const archivedParent = agent({ id: "ap", title: "旧主会话", archivedAt: iso(T0) });
  const orphan = agent({ id: "oc", title: "子", status: "running", labels: { [PARENT]: "ap" } });
  const st2 = buildState([host("s1", "Mac", [archivedParent, orphan])], T0 / 1000);
  assert.deepEqual(st2.rows.map(r => [r.agentId, r.title]), [["oc", "子"]]);

  const remoteKid = agent({ id: "rk", status: "running", labels: { [PARENT]: "g0", "paseo.parent-server-id": "s9" } });
  const st3 = buildState([host("s1", "Mac", [root, remoteKid])], T0 / 1000);
  assert.deepEqual(st3.rows.map(r => r.agentId), ["rk"]);
});

test("嵌套子会话仍不发通知", () => {
  const notified: NotifiedMap = new Map();
  const root = agent({ id: "nr" });
  const kid = attn("finished", T0 - 1000, { id: "nk", labels: { [PARENT]: "nr" } });
  const list = new Map([root, kid].map(x => [x.id, x]));
  assert.equal(checkAlert(kid, "s1", list, notified, T0), null);
});

// ---------- 通知正文预览（移植官方） ----------

test("preview：去 Markdown、折叠空白、超过 220 字以 ... 截断", () => {
  assert.equal(stripMarkdownToText("# 标题\n> 引用\n- **粗** `代码` [链接](http://x) ![图](a.png) <http://y>"), "标题\n引用\n粗 代码 链接 图 http://y");
  assert.equal(buildNotificationPreview("```ts\nconst a = 1;\n```\n\n  完成了   修改\n"), "const a = 1; 完成了 修改");
  assert.equal(buildNotificationPreview(null), null);
  assert.equal(buildNotificationPreview("  \n```\n```"), null);
  const exact = "字".repeat(220);
  assert.equal(buildNotificationPreview(exact), exact);
  const long = buildNotificationPreview("字".repeat(221) + "😀".repeat(5));
  assert.equal(long, "字".repeat(217) + "...");
  // 按码点截，不切坏 emoji
  assert.equal(buildNotificationPreview("😀".repeat(230)), "😀".repeat(217) + "...");
});

test("最后一条回复：拼接时间线末尾连续的 assistant_message 片段；兼容 entry.item 与直接 item", () => {
  assert.equal(findLatestAssistantMessageFromTimeline([
    { type: "assistant_message", text: "旧回复" }, { type: "tool_call" },
    { type: "assistant_message", text: "新" }, { type: "assistant_message", text: "回复" }, { type: "reasoning", text: "想" },
  ]), "新回复");
  assert.equal(findLatestAssistantMessageFromTimeline([{ type: "user_message", text: "hi" }]), null);
  assert.equal(latestReplyFromEntries([
    { item: { type: "user_message", text: "问" } },
    { item: { type: "assistant_message", text: "答**一**" } },
    { type: "assistant_message", text: "二" },
    null, { item: "bad" },
  ]), "答**一**二");
  assert.equal(latestReplyFromEntries([]), null);
});

test("权限说明：title 与 description 用 - 拼，相同只留一个；否则 input JSON，再否则 name / kind", () => {
  assert.equal(buildPermissionDetails({ title: "运行命令", description: "npm test" }), "运行命令 - npm test");
  assert.equal(buildPermissionDetails({ title: "运行命令", description: " 运行命令 " }), "运行命令");
  assert.equal(buildPermissionDetails({ description: "只有描述" }), "只有描述");
  assert.equal(buildPermissionDetails({ inputJson: '{"command":"ls"}', name: "Bash" }), '{"command":"ls"}');
  assert.equal(buildPermissionDetails({ name: " Bash ", kind: "tool" }), "Bash");
  assert.equal(buildPermissionDetails({ kind: "tool" }), "tool");
  assert.equal(buildPermissionDetails(null), null);
  // toLite 存 description 与 input 的 JSON（截到 300 字），不持有原始对象
  const lite = toLite({ ...agent({ id: "pl" }), pendingPermissions: [{ id: "r1", name: "Bash", kind: "tool", description: "d".repeat(400), input: { command: "x".repeat(400) } }] } as unknown as AgentLite);
  const perm = lite.pendingPermissions[0];
  assert.equal(perm.description?.length, 300);
  assert.equal(perm.inputJson?.length, 300);
  assert.ok(perm.inputJson?.startsWith('{"command":"xxx'));
  assert.equal("input" in perm, false);
  const noText = toLite({ ...agent({ id: "pl2" }), pendingPermissions: [{ id: "r1", name: "Bash", kind: "tool", input: { command: "ls  -la" } }] } as unknown as AgentLite);
  const p = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: noText, reason: "permission", requestId: "r1" });
  assert.equal(p.aps.alert.body, '{"command":"ls -la"}');
});

test("载荷：完成用最后回复的预览作正文，无 subtitle；取不到回复退回项目名 · 机器名；出错折叠空白", () => {
  const ws = new Map([["w1", { project: "宴小助", title: "修登录页" }]]);
  const fin = agent({ id: "f1", title: "写文档", workspaceId: "w1" });
  const f = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: fin, reason: "finished", workspaces: ws, assistantMessage: "## 已完成\n\n- 改了 **登录页**\n- 跑了测试" });
  assert.deepEqual(f.aps.alert, { title: "完成 · 修登录页", body: "已完成 改了 登录页 跑了测试" });
  for (const assistantMessage of [null, undefined, "   "]) {
    assert.equal(buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: fin, reason: "finished", workspaces: ws, assistantMessage }).aps.alert.body, "宴小助 · Studio");
  }
  const err = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: { ...fin, lastError: "连接\n\n  失败  了" }, reason: "error", workspaces: ws });
  assert.deepEqual(err.aps.alert, { title: "出错了 · 修登录页", body: "连接 失败 了" });
  const perm = buildAlertPayload({ serverId: "s1", hostLabel: "Studio", agent: { ...fin, pendingPermissions: [{ id: "r1", title: "编辑文件", description: "src/a.ts" }] }, reason: "permission", requestId: "r1", workspaces: ws });
  assert.deepEqual(perm.aps.alert, { title: "需要你批准 · 修登录页", body: "编辑文件 - src/a.ts" });
});
