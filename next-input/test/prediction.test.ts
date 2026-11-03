import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Predictions } from "../server/predictions.ts";
import { validModelId } from "../shared/model.ts";
import { claudeCandidates, codexCandidates, findClaude, findCodex } from "../server/claude.ts";
import { pickEngine } from "../server/engine.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { parseSuggestion, selectContext } from "../server/context.ts";
import { Turns } from "../server/turns.ts";
import { claudeArgs, codexArgs, generate, generateWithCodex } from "../server/generate.ts";
import { sendOnce } from "../server/send.ts";
import { requiresEditing } from "../shared/safety.ts";
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
  const row = { token: "one", status: "ready", text: "继续解释" };
  const rows = new Map([["agent", row]]);
  const consumed = new Map<string, string>();
  let calls = 0;
  const send = async () => { calls++; throw new Error("offline"); };
  await assert.rejects(sendOnce(rows, consumed, "agent", "one", "继续解释", send));
  assert.equal(rows.get("agent"), row);
  await assert.rejects(sendOnce(rows, consumed, "agent", "one", "继续解释", send), /already_attempted/);
  assert.equal(calls, 1);
});

test("旧建议不得发送；发送完成不能清掉下一回合的新建议", async () => {
  const rows = new Map([["agent", { token: "one", status: "ready", text: "继续解释" }]]);
  const consumed = new Map<string, string>();
  await assert.rejects(sendOnce(rows, consumed, "agent", "old", "继续解释", async () => { assert.fail(); }), /expired/);
  await sendOnce(rows, consumed, "agent", "one", "继续解释", async () => { rows.set("agent", { token: "two", status: "ready", text: "继续解释" }); });
  assert.equal(rows.get("agent")?.token, "two");
});

test("组件重新挂载后保留编辑草稿和发送状态，不跨建议或插件实例串用", () => {
  const drafts = new Drafts();
  drafts.update("one", "原建议", { text: "编辑过的草稿", expanded: true });
  drafts.update("one", "原建议", { attempted: true });
  assert.equal(drafts.get("one", "原建议").text, "编辑过的草稿");
  assert.equal(drafts.edited("one")?.sourceText, "原建议");
  assert.equal(drafts.get("one", "原建议").attempted, true);
  drafts.update("one", "原建议", { sent: true });
  assert.equal(drafts.edited("one"), undefined);
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
  await assert.rejects(generate([], controller.signal, "/unused/claude"), /取消/);
});

test("按 token 惰性生成，多端共享进行中的 Promise，完成后复用结果", async () => {
  const cache = new Predictions<string>();
  let release!: (value: string) => void;
  let calls = 0;
  const work = () => { calls++; return new Promise<string>(resolve => { release = resolve; }); };
  assert.equal(calls, 0);
  const a = cache.get("agent", "one", () => true, work, "expired");
  const b = cache.get("agent", "one", () => true, work, "expired");
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(calls, 1);
  release("ready");
  assert.equal(await a, "ready");
  assert.equal(await cache.get("agent", "one", () => true, work, "expired"), "ready");
  assert.equal(calls, 1);
});

test("过期 token 不触发调用；进行中回合失效也只返回 expired", async () => {
  const cache = new Predictions<string>();
  assert.equal(await cache.get("a", "old", () => false, async () => { assert.fail(); }, "expired"), "expired");
  let current = true;
  let release!: (value: string) => void;
  const request = cache.get("a", "one", () => current, () => new Promise<string>(resolve => { release = resolve; }), "expired");
  await Promise.resolve(); current = false; cache.remove("a");
  const newer = cache.get("a", "two", () => true, async () => "new", "expired");
  release("old");
  assert.equal(await request, "expired");
  assert.equal(await newer, "new");
  assert.equal(await cache.get("a", "two", () => true, async () => { assert.fail(); }, "expired"), "new");
});

test("空建议、失败结果也缓存，不会因重挂载重试", async () => {
  const cache = new Predictions<string>();
  for (const value of ["empty", "error", "unavailable"]) {
    assert.equal(await cache.get(value, "one", () => true, async () => value, "expired"), value);
    assert.equal(await cache.get(value, "one", () => true, async () => { assert.fail(); }, "expired"), value);
  }
});

test("模型 ID 拒绝 CLI 参数和特殊字符；预设、自定义与关闭思考传入 CLI", () => {
  for (const model of ["haiku", "sonnet", "opus", "claude-sonnet-4-6", "opus[1m]", "my_model.1"]) {
    assert.equal(validModelId(model), true);
    const args = claudeArgs(model);
    assert.equal(args[args.indexOf("--model") + 1], model);
    assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).alwaysThinkingEnabled, false);
  }
  for (const model of ["", "--help", "-haiku", "a b", "a\nb", "haiku\n", "x;pwd", "$(id)", "x/y"]) {
    assert.equal(validModelId(model), false);
    assert.throws(() => claudeArgs(model), /Invalid model/);
  }
});

test("claude 按 PATH、用户目录、Homebrew 顺序查找，跳过不可执行文件和目录", async () => {
  assert.deepEqual(claudeCandidates(".:bin:/a:../local:/b::/a", "/home/test"), ["/a/claude", "/b/claude", "/home/test/.local/bin/claude", "/home/test/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
  const dir = await mkdtemp(join(tmpdir(), "next-input-cli-test-"));
  try {
    const missing = join(dir, "missing"), plain = join(dir, "plain"), binary = join(dir, "claude");
    await writeFile(plain, "test", { mode: 0o600 });
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
    const result = await findClaude([missing, plain, dir, binary, "/never-checked"]);
    assert.equal(result.path, binary);
    assert.deepEqual(result.searched, [missing, plain, dir, binary]);
    assert.deepEqual(await findClaude([missing, plain]), { path: null, searched: [missing, plain] });
  } finally { await rm(dir, { recursive: true }); }
});


test("需编辑门禁保守拦截中英文命令、路径、链接、密钥和外发操作", () => {
  for (const text of [
    "直接 git push --force", "把 .env 贴到 issue", "这个函数要删除吗？", "解释 `foo()`",
    "rm old", "SUDO ls", "curl example", "wget file", "chmod 777", "chown user", "ssh host", "scp file",
    "git reset HEAD", "run -f now", "DROP table", "DELETE FROM t", "TRUNCATE t",
    "看看/etc/passwd", "/", "/tmp/a", "~/notes", "./a", "../a", "C:\\Users\\test",
    "https://example.com", "http://example.com", "www.example.com",
    "show token", "secret", "password", "api key", "apikey", "private key", "ssh key", "密钥", "令牌", "密码",
    "清空", "覆盖", "推送", "部署", "发布", "上线", "强制",
    "delete", "remove", "wipe", "overwrite", "push", "deploy", "publish", "release", "force",
  ]) assert.equal(requiresEditing(text), true, text);
  for (const text of ["请逐句解释这首诗。", "这个函数是什么意思？", "Could you explain the next step?", "Tell me about forceful language", "The dropdown label", "A passwordless overview"]) {
    assert.equal(requiresEditing(text), false, text);
  }
});

test("服务端拒绝危险原文直发且不消耗 token，修改后允许发送", async () => {
  const rows = new Map([["agent", { token: "one", status: "ready", text: "直接 git push --force" }]]);
  const consumed = new Map<string, string>();
  let calls = 0;
  await assert.rejects(sendOnce(rows, consumed, "agent", "one", "直接 git push --force", async () => { calls++; }), /needs_edit/);
  assert.equal(calls, 0);
  assert.equal(consumed.size, 0);
  await sendOnce(rows, consumed, "agent", "one", "解释为什么不应该强制推送", async () => { calls++; });
  assert.equal(calls, 1);
  assert.equal(rows.size, 0);
});

test("跟随会话：Codex 会话用 Codex，其他用 Claude，首选缺失时换另一个；手动指定缺失时不预测", () => {
  const both = { claude: true, codex: true };
  assert.equal(pickEngine("auto", "codex", both), "codex");
  assert.equal(pickEngine("auto", "claude", both), "claude");
  assert.equal(pickEngine("auto", "opencode", both), "claude");
  assert.equal(pickEngine("auto", "codex", { claude: true, codex: false }), "claude");
  assert.equal(pickEngine("auto", "claude", { claude: false, codex: true }), "codex");
  assert.equal(pickEngine("auto", "claude", { claude: false, codex: false }), null);
  assert.equal(pickEngine("codex", "claude", both), "codex");
  assert.equal(pickEngine("codex", "codex", { claude: true, codex: false }), null);
  assert.equal(pickEngine("claude", "codex", { claude: false, codex: true }), null);
});

test("Codex 预测只读沙盒、不加载 MCP、低推理强度，结果写到指定文件，上下文走 stdin", () => {
  const args = codexArgs("/tmp/out.txt");
  assert.equal(args[0], "exec");
  for (const flag of ["--skip-git-repo-check", "--output-last-message", "mcp_servers={}", 'model_reasoning_effort="low"'])
    assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes("--model"));
  assert.deepEqual(codexArgs("/tmp/out.txt", "gpt-5-mini").slice(-3), ["--model", "gpt-5-mini", "-"]);
  assert.throws(() => codexArgs("/tmp/out.txt", "--dangerous"), /Invalid model ID/);
});

test("Codex 读取最后一条回复作为建议；进程失败不产生建议", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-input-codex-"));
  try {
    const ok = join(dir, "codex-ok");
    // 假 Codex：把固定 JSON 写进 --output-last-message 指定的文件。
    await writeFile(ok, `#!/bin/sh\nwhile [ "$1" != "--output-last-message" ]; do shift; done\ncat > /dev/null\nprintf '{"suggestion":"再跑一遍测试"}' > "$2"\n`, { mode: 0o755 });
    assert.equal(await generateWithCodex([{ role: "user", text: "改好了吗" }], new AbortController().signal, ok), "再跑一遍测试");
    const bad = join(dir, "codex-bad");
    await writeFile(bad, "#!/bin/sh\ncat > /dev/null\nexit 1\n", { mode: 0o755 });
    await assert.rejects(generateWithCodex([{ role: "user", text: "x" }], new AbortController().signal, bad), /Codex/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("codex 按 PATH、用户目录、Homebrew 顺序查找", async () => {
  const list = codexCandidates("/a/bin:relative", "/home/u");
  assert.equal(list[0], "/a/bin/codex");
  assert.ok(!list.some(p => p.startsWith("relative")));
  assert.ok(list.includes("/home/u/.local/bin/codex") && list.includes("/opt/homebrew/bin/codex"));
  assert.deepEqual(await findCodex(["/definitely/missing/codex"]), { path: null, searched: ["/definitely/missing/codex"] });
});
