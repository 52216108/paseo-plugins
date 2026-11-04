import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// 预测只需要「读对话、写一句话」，用不到任何工具。Codex 若沿用用户自己的 CODEX_HOME，会带上那里的 MCP 服务器、
// 插件、技能、钩子和 AGENTS.md，命令执行等工具也都开着；而对话内容不可信（可能含提示注入），预测又在后台自动运行、
// 用户看不到也不用批准。所以每次预测都在一个临时 CODEX_HOME 里跑：只放登录凭据和下面这份配置，跑完删掉。
//
// 已知残留：这个 Codex 版本里 multi_agent 关不掉，模型仍可派子代理；子代理共用同一份隔离配置，
// 同样没有命令执行和 MCP，最坏只是多一次模型调用。
export const isolatedCodexConfig = `model_reasoning_effort = "low"
web_search = "disabled"

[features]
shell_tool = false
unified_exec = false
code_mode_host = false
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

/** The user's Codex home, where the login lives. */
export function sourceCodexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CODEX_HOME || join(home, ".codex");
}

export interface IsolatedCodexHome {
  /** Temporary root (0700): `home` is the CODEX_HOME, `work` an empty working directory. */
  root: string;
  home: string;
  work: string;
  /** Writes back refreshed login tokens (see writeBackRefreshedAuth), then deletes everything. */
  finish(): Promise<void>;
}

export async function isolatedCodexHome(source = sourceCodexHome()): Promise<IsolatedCodexHome> {
  const root = await mkdtemp(join(tmpdir(), "next-input-codex-")); // mkdtemp 创建的目录权限为 0700
  const home = join(root, "home");
  const work = join(root, "work");
  let original: Buffer | null = null;
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    await writeFile(join(home, "config.toml"), isolatedCodexConfig, { mode: 0o600 });
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
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Codex may refresh its tokens during a run, and refresh tokens rotate: if the new ones stayed only in the
 * temporary home, the user's own login would be left holding a revoked refresh token. So when the copy changed
 * and the user's file is still exactly what we copied, the refreshed file replaces it (atomically). If the user's
 * file changed meanwhile (their own Codex refreshed), theirs is kept.
 */
export async function writeBackRefreshedAuth(real: string, original: Buffer, used: string): Promise<boolean> {
  let after: Buffer;
  try { after = await readFile(used); } catch { return false; }
  if (after.equals(original)) return false;
  let current: Buffer;
  try { current = await readFile(real); } catch { return false; }
  if (!current.equals(original)) return false;
  const temporary = `${real}.next-input-${process.pid}-${Date.now()}`;
  await writeFile(temporary, after, { mode: 0o600 });
  await rename(temporary, real);
  return true;
}
