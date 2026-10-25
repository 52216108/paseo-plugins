type Entry = { turnId?: string; item: { type: string; text?: string } };
export type Message = { role: "user" | "assistant"; text: string };

// 只发送可见对话，不发送工具结果、思考过程、附件内容或其他会话。
export function selectContext(entries: readonly Entry[], turnId: string | null): Message[] {
  const end = turnId ? entries.findLastIndex(e => e.turnId === turnId && e.item.type === "assistant_message") : entries.length - 1;
  if (end < 0) return [];
  const conversation: Entry[] = [];
  for (const entry of entries.slice(0, end + 1)) {
    if (!["user_message", "assistant_message"].includes(entry.item.type) || !entry.item.text?.trim()) continue;
    // projected 时间线已合并流式分片；同一段连续进度只保留最终回答。
    if (entry.item.type === "assistant_message" && conversation.at(-1)?.item.type === "assistant_message") conversation.pop();
    conversation.push(entry);
  }
  const messages = conversation.slice(-8);
  let budget = 12_000;
  const result: Message[] = [];
  for (const entry of messages.toReversed()) {
    if (budget <= 0) break;
    const text = entry.item.text!.trim().slice(-Math.min(budget, 4000));
    if (!text) break;
    result.unshift({ role: entry.item.type === "user_message" ? "user" : "assistant", text });
    budget -= text.length;
  }
  return result.at(-1)?.role === "assistant" && result.some(m => m.role === "user") ? result : [];
}

export function parseSuggestion(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("suggestion" in value) || typeof value.suggestion !== "string") {
    throw new Error("模型没有返回有效建议");
  }
  const text = value.suggestion.trim();
  if (text.length > 160 || /[\r\n]/.test(text)) throw new Error("模型建议格式不正确");
  return text;
}
