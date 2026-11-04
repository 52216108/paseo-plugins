// 纯函数：通知正文的预览文本。按官方 App 的 packages/protocol/src/agent-attention-notification.ts 移植
// （buildNotificationPreview / stripMarkdownToText / buildPermissionDetails / findLatestAssistantMessageFromTimeline）。

export const NOTIFICATION_PREVIEW_LIMIT = 220;

/** 空白（含换行）折叠成单个空格并去掉首尾空白。 */
export function normalizeNotificationText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 超出 limit 时截短并以 "..." 结尾（同官方）；按码点计数，不切坏 emoji / 生僻字。 */
export function truncateNotificationText(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const trimmed = chars.slice(0, Math.max(0, limit - 3)).join("").trimEnd();
  return trimmed.length > 0 ? `${trimmed}...` : chars.slice(0, limit).join("");
}

/** 去掉 Markdown 标记，保留文字（代码块保留内容、链接保留文字）。 */
/** 处理前先截到这么长：通知只显示 220 字，超长回复不必整段跑正则（也避免超长空白造成大量回溯）。 */
export const PREVIEW_INPUT_MAX_CHARS = 4000;

export function stripMarkdownToText(markdown: string): string {
  let text = Array.from(markdown).slice(0, PREVIEW_INPUT_MAX_CHARS).join("").replace(/\r\n/g, "\n");
  // 代码围栏行去掉，代码本身保留（行首只认空格 / 制表符，不跨行匹配）。
  text = text.replace(/^[ \t]*```[^\n]*$/gm, "");
  text = text.replace(/^[ \t]*~~~[^\n]*$/gm, "");
  // 图片 / 链接。
  text = text.replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  // 行首结构：标题、引用、列表、分隔线。
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}>+[ \t]?/gm, "");
  text = text.replace(/^[ \t]{0,3}(?:[*+-]|\d+\.)[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, "");
  // 行内标记。
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/_([^_\n]+)_/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  // 尖括号自动链接。
  text = text.replace(/<([^>\n]+)>/g, "$1");
  return text;
}

/** 通知正文预览：去 Markdown → 折叠空白 → 截到 220 字；空了返回 null。 */
export function buildNotificationPreview(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = normalizeNotificationText(stripMarkdownToText(text));
  if (!normalized) return null;
  return truncateNotificationText(normalized, NOTIFICATION_PREVIEW_LIMIT);
}

export function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * 权限请求的说明：title 与 description（不同时）用 " - " 拼；都没有就用工具名 / kind。
 * 与官方不同：不退回工具输入 / 元数据的 JSON（可能含令牌等敏感内容，会经 Apple 推送服务器显示在锁屏上）。
 */
export function buildPermissionDetails(request: {
  title?: string | null; description?: string | null; name?: string | null; kind?: string | null;
} | null | undefined): string | null {
  if (!request) return null;
  const title = request.title?.trim();
  const description = request.description?.trim();
  const details: string[] = [];
  if (title) details.push(title);
  if (description && description !== title) details.push(description);
  if (details.length > 0) return details.join(" - ");
  return request.name?.trim() || request.kind || null;
}

export interface TimelineItemLike { type: string; text?: unknown }

/** 时间线末尾连续的 assistant_message 片段拼起来就是最后一条回复（provider 会分片流式输出）。 */
export function findLatestAssistantMessageFromTimeline(timeline: readonly TimelineItemLike[]): string | null {
  const chunks: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type !== "assistant_message" || typeof item.text !== "string") {
      if (chunks.length > 0) break;
      continue;
    }
    chunks.push(item.text);
  }
  if (chunks.length === 0) return null;
  return chunks.reverse().join("");
}

/** timeline.refetch 返回的条目：正常是 { item: {...} }，兼容直接给 item 的形状。 */
export function latestReplyFromEntries(entries: readonly unknown[]): string | null {
  const items: TimelineItemLike[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { item?: unknown; type?: unknown };
    const item = (e.item && typeof e.item === "object" ? e.item : e) as { type?: unknown; text?: unknown };
    if (typeof item.type === "string") items.push({ type: item.type, text: item.text });
  }
  return findLatestAssistantMessageFromTimeline(items);
}
