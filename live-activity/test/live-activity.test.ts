import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { buildState, type AgentLite, type HostData } from "../server/summary.ts";
import { applyResult, decide, ROTATE_AFTER_MS, START_COOLDOWN_MS, REFRESH_MS, type Device } from "../server/decide.ts";
import { signJwt, validateKey, loadPrivateKey } from "../server/apns.ts";

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
    pushToStartToken: "aa".repeat(32), activityToken: null, hosts: [{ serverId: "s1", label: "Mac" }],
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
  assert.equal(decide(d, running(3), T0 + START_COOLDOWN_MS)[0].kind, "start");
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
