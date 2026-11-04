import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export function claudeCandidates(path = process.env.PATH ?? "", home = homedir()): string[] {
  return [...new Set([
    ...path.split(delimiter).filter(isAbsolute).map(dir => resolve(dir, "claude")),
    join(home, ".local/bin/claude"), join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
  ])];
}

export function codexCandidates(path = process.env.PATH ?? "", home = homedir()): string[] {
  return [...new Set([
    ...path.split(delimiter).filter(isAbsolute).map(dir => resolve(dir, "codex")),
    join(home, ".local/bin/codex"), join(home, ".npm-global/bin/codex"), join(home, ".bun/bin/codex"),
    "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
  ])];
}

export const findCodex = (candidates = codexCandidates()) => findExecutable(candidates);
export const findClaude = (candidates = claudeCandidates()) => findExecutable(candidates);

async function findExecutable(candidates: string[]): Promise<{ path: string | null; searched: string[] }> {
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
