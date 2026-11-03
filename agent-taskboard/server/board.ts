import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BOARD_URL } from "../shared/board";

// 看板设了 BOARD_TOKEN 后读请求也要鉴权；与看板 CLI 同源：环境变量优先，其次 ~/.project-board/token
async function boardToken(): Promise<string | null> {
  if (process.env.BOARD_TOKEN) return process.env.BOARD_TOKEN;
  try {
    return (await readFile(join(homedir(), ".project-board", "token"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

// 看板首次扫描磁盘可能要几秒，留足余量
const TIMEOUT_MS = 8_000;

interface BoardProject {
  name: string;
  path: string;
  missing?: boolean;
}

async function safeReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

// 与看板 CLI 的 resolveHere 同一规则：取路径最长匹配（在子仓里命中子仓，在外壳里命中工作区），跳过已失效的旧行
async function match(projects: BoardProject[], dir: string): Promise<string | null> {
  const cwd = await safeReal(dir);
  let best: string | null = null;
  let bestLen = -1;
  for (const p of projects) {
    if (p.missing || !p.path) continue;
    const pp = await safeReal(p.path);
    if ((cwd === pp || cwd.startsWith(pp + "/")) && pp.length > bestLen) {
      best = p.name;
      bestLen = pp.length;
    }
  }
  return best;
}

export async function locateBoard(paths: string[]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const token = await boardToken();
    const response = await fetch(`${BOARD_URL}/api/projects`, {
      signal: controller.signal,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { url: BOARD_URL, reachable: false, error: `HTTP ${response.status}`, project: null };
    }
    const { projects } = (await response.json()) as { projects: BoardProject[] };
    for (const dir of paths) {
      const project = await match(projects, dir);
      if (project) return { url: BOARD_URL, reachable: true, project };
    }
    return { url: BOARD_URL, reachable: true, project: null };
  } catch (error) {
    const message = controller.signal.aborted ? "连接超时" : error instanceof Error ? error.message : String(error);
    return { url: BOARD_URL, reachable: false, error: message, project: null };
  } finally {
    clearTimeout(timer);
  }
}
