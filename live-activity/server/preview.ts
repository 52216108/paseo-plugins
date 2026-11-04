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
export function stripMarkdownToText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");
  // 代码围栏行去掉，代码本身保留。
  text = text.replace(/^\s*```[^\n]*$/gm, "");
  text = text.replace(/^\s*~~~[^\n]*$/gm, "");
  // 图片 / 链接。
  text = text.replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  // 行首结构：标题、引用、列表、分隔线。
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>+\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[*+-]|\d+\.)\s+/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "");
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
 * 权限请求的说明：title 与 description（不同时）用 " - " 拼；都没有就用 input 的 JSON，再没有用 metadata 的 JSON，
 * 最后用 name / kind。inputJson / metadataJson 是已序列化（并截短）的 JSON，插件不长期持有原始对象。
 */
export function buildPermissionDetails(request: {
  title?: string | null; description?: string | null; name?: string | null; kind?: string | null;
  inputJson?: string | null; metadataJson?: string | null;
} | null | undefined): string | null {
  if (!request) return null;
  const title = request.title?.trim();
  const description = request.description?.trim();
  const details: string[] = [];
  if (title) details.push(title);
  if (description && description !== title) details.push(description);
  if (details.length > 0) return details.join(" - ");
  if (request.inputJson) return request.inputJson;
  if (request.metadataJson) return request.metadataJson;
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
