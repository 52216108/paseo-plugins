import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export function claudeCandidates(path = process.env.PATH ?? "", home = homedir()): string[] {
  return [...new Set([
    ...path.split(delimiter).filter(Boolean).map(dir => resolve(dir, "claude")),
    join(home, ".local/bin/claude"), join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
  ])];
}

export async function findClaude(candidates = claudeCandidates()): Promise<{ path: string | null; searched: string[] }> {
  const searched: string[] = [];
  for (const path of candidates) {
    searched.push(path);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return { path, searched };
    } catch { /* 继续查找下一个安装位置。 */ }
  }
  return { path: null, searched };
}
