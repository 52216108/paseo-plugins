import { requiresEditing } from "../shared/safety.ts";

// 失败或结果不明时保留展示数据，但同一 token 不可自动重试。
export async function sendOnce<T extends { token: string; status: string; text: string }>(
  rows: Map<string, T>, consumed: Map<string, string>, agentId: string, token: string,
  text: string, send: () => Promise<void>,
): Promise<void> {
  const row = rows.get(agentId);
  if (!row || row.token !== token || row.status !== "ready") throw new Error("suggestion_expired");
  if (text === row.text && requiresEditing(row.text)) throw new Error("needs_edit");
  if (consumed.get(agentId) === token) throw new Error("suggestion_already_attempted");
  consumed.set(agentId, token);
  await send();
  if (rows.get(agentId) === row) rows.delete(agentId);
}
