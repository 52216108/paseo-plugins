import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// 预测只需要「读对话、写一句话」，用不到任何工具。Codex 若沿用用户自己的 CODEX_HOME，会带上那里的 MCP 服务器、
// 插件、技能、钩子和 AGENTS.md，命令执行等工具也都开着；而对话内容不可信（可能含提示注入），预测又在后台自动运行、
// 用户看不到也不用批准。所以每次预测都在一个临时 CODEX_HOME 里跑：只放登录凭据、下面这份配置和用户配置里
// 与连接有关的几项（connectionSettings），跑完删掉。
//
// 已知残留：这个 Codex 版本里 multi_agent 关不掉，模型仍可派子代理；子代理共用同一份隔离配置，
// 同样没有命令执行和 MCP，最坏只是多一次模型调用。
export const isolatedCodexConfig = `model_reasoning_effort = "low"
web_search = "disabled"

[features]
shell_tool = false
unified_exec = false
code_mode_host = false
js_repl = false
view_image = false
apps = false
plugins = false
browser_use = false
browser_use_external = false
computer_use = false
in_app_browser = false
image_generation = false
multi_agent = false
multi_agent_v2 = false
memories = false
hooks = false
skill_search = false
skill_mcp_dependency_install = false
tool_suggest = false
sleep_tool = false
goals = false
`;

const PREFIX = "next-input-codex-";
// Top-level keys that only say where and how to connect; they turn on no tool.
const CONNECTION_KEYS = new Set(["model_provider", "chatgpt_base_url", "forced_chatgpt_workspace_id", "forced_login_method"]);

/**
 * The parts of the user's config.toml that decide where requests go (custom provider, gateway, workspace), so a
 * prediction is sent to the same endpoint as the user's own Codex. Whitelisted line by line: top-level connection
 * keys and whole `[model_providers.*]` tables. Nothing else is copied (`notify`, profiles, projects' trust, MCP…).
 */
export function connectionSettings(userConfig: string): string {
  const top: string[] = [];
  const tables: string[] = [];
  let section: string | null = null;
  for (const line of userConfig.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      section = header[1];
      if (/^model_providers\./.test(section)) tables.push(line);
      continue;
    }
    if (section === null) {
      const key = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line)?.[1];
      if (key && CONNECTION_KEYS.has(key)) top.push(line);
    } else if (/^model_providers\./.test(section)) {
      tables.push(line);
    }
  }
  return [...top, "", ...tables].join("\n").trim();
}

/** The user's Codex home, where the login lives. */
export function sourceCodexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CODEX_HOME || join(home, ".codex");
}

export interface IsolatedCodexHome {
  /** Temporary root (0700): `home` is the CODEX_HOME, `work` an empty working directory. */
  root: string;
  home: string;
  work: string;
  /** Writes back refreshed login tokens (see writeBackRefreshedAuth), then deletes everything. Never throws. */
  finish(): Promise<void>;
}

/**
 * Removes isolated homes left by a daemon that crashed mid-prediction (they hold a copy of the login). Only real
 * directories owned by this user count: on a shared /tmp another user could plant an entry with the same prefix,
 * and a symlink must never be followed.
 */
export async function sweepStaleHomes(dir = tmpdir(), olderThanMs = 10 * 60_000, now = Date.now()): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  for (const name of names.filter(n => n.startsWith(PREFIX))) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      const mine = typeof process.getuid !== "function" || info.uid === process.getuid();
      if (info.isDirectory() && !info.isSymbolicLink() && mine && now - info.mtimeMs > olderThanMs) {
        await rm(path, { recursive: true, force: true });
      }
    } catch { /* 别的进程刚删掉，忽略。 */ }
  }
}

export async function isolatedCodexHome(source = sourceCodexHome()): Promise<IsolatedCodexHome> {
  await sweepStaleHomes();
  const root = await mkdtemp(join(tmpdir(), PREFIX)); // mkdtemp 创建的目录权限为 0700
  const home = join(root, "home");
  const work = join(root, "work");
  let original: Buffer | null = null;
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    let connection = "";
    try { connection = connectionSettings(await readFile(join(source, "config.toml"), "utf8")); } catch { /* 没有用户配置。 */ }
    // TOML：顶层键必须写在任何 [表] 之前，所以是「连接用的顶层键 → 隔离配置（含 [features]）→ [model_providers.*]」。
    const config = [connectionTop(connection), isolatedCodexConfig, connectionTables(connection)].filter(Boolean).join("\n") + "\n";
    await writeFile(join(home, "config.toml"), config, { mode: 0o600 });
    try {
      original = await readFile(join(source, "auth.json"));
    } catch { /* 用 API key 环境变量登录时没有 auth.json，照样可以跑。 */ }
    if (original) await writeFile(join(home, "auth.json"), original, { mode: 0o600 });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root, home, work,
    async finish() {
      try {
        if (original) await writeBackRefreshedAuth(join(source, "auth.json"), original, join(home, "auth.json"));
      } catch {
        // 写回失败不影响已经拿到的建议；用户自己的凭据没有被改动。
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function connectionTop(settings: string): string {
  const firstTable = settings.search(/^\s*\[/m);
  return (firstTable < 0 ? settings : settings.slice(0, firstTable)).trim();
}

function connectionTables(settings: string): string {
  const firstTable = settings.search(/^\s*\[/m);
  return firstTable < 0 ? "" : settings.slice(firstTable).trim();
}

/** A refreshed login worth keeping: complete JSON that still carries a refresh token (not a half-written file). */
function isCompleteAuth(data: Buffer): boolean {
  try {
    const auth = JSON.parse(data.toString("utf8"));
    if (typeof auth !== "object" || auth === null) return false;
    if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) return true;
    return typeof auth.tokens === "object" && auth.tokens !== null && typeof auth.tokens.refresh_token === "string"
      && auth.tokens.refresh_token.length > 0;
  } catch {
    return false;
  }
}

/**
 * Codex may refresh its tokens during a run, and refresh tokens rotate: if the new ones stayed only in the
 * temporary home, the user's own login would be left holding a revoked refresh token. So when the copy changed,
 * is a complete login (not cut off by a kill mid-write), and the user's file is still exactly what we copied, the
 * refreshed file replaces it atomically (through a symlink to its target). If the user's file changed meanwhile
 * (their own Codex refreshed), theirs is kept.
 */
export async function writeBackRefreshedAuth(real: string, original: Buffer, used: string): Promise<boolean> {
  let after: Buffer;
  try { after = await readFile(used); } catch { return false; }
  if (after.equals(original) || !isCompleteAuth(after)) return false;
  let target: string;
  let current: Buffer;
  try {
    target = await realpath(real);
    current = await readFile(target);
  } catch { return false; }
  if (!current.equals(original)) return false;
  const temporary = `${target}.next-input-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, after, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}
