import test from "node:test";
import assert from "node:assert/strict";
import { parseSuggestion, selectContext } from "../server/context.ts";
import { Turns } from "../server/turns.ts";
import { claudeArgs, generate } from "../server/generate.ts";
import { sendOnce } from "../server/send.ts";
import { Drafts } from "../client/drafts.ts";

test("上下文排除工具、思考和下一回合，保留用户与回答", () => {
  const rows = [
    { turnId: "one", item: { type: "user_message", text: "登录出错了" } },
    { turnId: "one", item: { type: "tool_call", text: "PRIVATE_TOOL_RESULT" } },
    { turnId: "one", item: { type: "reasoning", text: "PRIVATE_REASONING" } },
    { turnId: "one", item: { type: "assistant_message", text: "缺少配置项" } },
    { turnId: "two", item: { type: "user_message", text: "新请求" } },
  ];
  assert.deepEqual(selectContext(rows, "one"), [
    { role: "user", text: "登录出错了" }, { role: "assistant", text: "缺少配置项" },
  ]);
  assert.deepEqual(selectContext(rows, "missing"), []);
});

test("上下文限制条数和字符总量，没有用户上下文时不猜测", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    turnId: "one", item: { type: i % 2 ? "assistant_message" : "user_message", text: "文".repeat(5000) },
  }));
  const context = selectContext(rows, "one");
  assert.ok(context.length <= 8);
  assert.ok(context.reduce((n, m) => n + m.text.length, 0) <= 12000);
  assert.ok(context.every(m => m.text.length <= 4000));
  assert.deepEqual(selectContext([{ item: { type: "assistant_message", text: "孤立的回复" } }], null), []);
});

test("长编码回合的进度消息不会挤掉用户要求和最终回答", () => {
  const rows = [
    { turnId: "one", item: { type: "user_message", text: "修复登录失败" } },
    ...Array.from({ length: 15 }, (_, i) => ({ turnId: "one", item: { type: "assistant_message", text: `进度 ${i}`.repeat(1000) } })),
    { turnId: "one", item: { type: "assistant_message", text: "已修复" } },
  ];
  assert.deepEqual(selectContext(rows, "one"), [
    { role: "user", text: "修复登录失败" }, { role: "assistant", text: "已修复" },
  ]);
});

test("模型没有合理建议可返回空；无效响应不能成为建议", () => {
  assert.equal(parseSuggestion('{"suggestion":"看看登录配置"}'), "看看登录配置");
  assert.equal(parseSuggestion('{"suggestion":""}'), "");
  for (const raw of ['not json', '{}', '{"suggestion":42}', JSON.stringify({ suggestion: "x".repeat(161) }), JSON.stringify({ suggestion: "一\n二" })]) {
    assert.throws(() => parseSuggestion(raw));
  }
});

test("新回合开始时取消旧预测；旧请求后返回也不能发布", async () => {
  const turns = new Turns();
  turns.start("agent", "one");
  const old = turns.end("agent", "one")!;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let published = false;
  const late = barrier.then(() => { published = turns.isCurrent("agent", old); });
  turns.start("agent", "two");
  release(); await late;
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(published, false);
  assert.equal(turns.end("agent", "one"), null);
  assert.ok(turns.end("agent", "two"));
  assert.equal(turns.end("agent", "two"), null);
});

test("不同对话独立；归档与卸载取消预测", () => {
  const turns = new Turns();
  const a = turns.start("a", "one");
  const b = turns.start("b", "one");
  turns.remove("a");
  assert.equal(turns.isCurrent("a", a), false);
  assert.equal(turns.isCurrent("b", b), true);
  turns.clear();
  assert.equal(b.controller.signal.aborted, true);
});

test("发送失败保留可复制的建议，重复点击不会重复调用发送", async () => {
  const row = { token: "one", status: "ready" };
  const rows = new Map([["agent", row]]);
  const consumed = new Map<string, string>();
  let calls = 0;
  const send = async () => { calls++; throw new Error("offline"); };
  await assert.rejects(sendOnce(rows, consumed, "agent", "one", send));
  assert.equal(rows.get("agent"), row);
  await assert.rejects(sendOnce(rows, consumed, "agent", "one", send), /already_attempted/);
  assert.equal(calls, 1);
});

test("旧建议不得发送；发送完成不能清掉下一回合的新建议", async () => {
  const rows = new Map([["agent", { token: "one", status: "ready" }]]);
  const consumed = new Map<string, string>();
  await assert.rejects(sendOnce(rows, consumed, "agent", "old", async () => { assert.fail(); }), /expired/);
  await sendOnce(rows, consumed, "agent", "one", async () => { rows.set("agent", { token: "two", status: "ready" }); });
  assert.equal(rows.get("agent")?.token, "two");
});

test("组件重新挂载后保留编辑草稿和发送状态，不跨建议或插件实例串用", () => {
  const drafts = new Drafts();
  drafts.update("one", "原建议", { text: "编辑过的草稿", expanded: true });
  drafts.update("one", "原建议", { attempted: true });
  assert.equal(drafts.get("one", "原建议").text, "编辑过的草稿");
  assert.equal(drafts.get("one", "原建议").attempted, true);
  assert.equal(drafts.get("two", "另一句").text, "另一句");
  assert.equal(new Drafts().get("one", "原建议").text, "原建议");
});

test("预测进程禁用工具、MCP、自定义 hooks 和持久化，不自动降级模型", async () => {
  const args = claudeArgs();
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(args.includes(flag));
  assert.equal(args.includes("--fallback-model"), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generate([], controller.signal), /取消/);
});
