import type { EngineSetting } from "../shared/contracts.ts";

export type Engine = "claude" | "codex";

// 「跟随会话」：Codex 会话用 Codex 预测，其他会话用 Claude；首选的 CLI 不存在时退到另一个。
// 手动指定的工具不存在时不预测，不悄悄换成另一个账户。
export function pickEngine(setting: EngineSetting, provider: string, available: Record<Engine, boolean>): Engine | null {
  const preferred: Engine = setting === "auto" ? (provider === "codex" ? "codex" : "claude") : setting;
  if (available[preferred]) return preferred;
  if (setting !== "auto") return null;
  const other: Engine = preferred === "claude" ? "codex" : "claude";
  return available[other] ? other : null;
}
