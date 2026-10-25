// 时间显示：一律按客户端本地时区，精确到分钟（daemon 给的 resetsAt 常是 xx:59:59.6，四舍五入到整分）

import type { Translate } from "./messages";

const MINUTE = 60_000;

export function roundToMinute(iso: string): Date | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.round(ms / MINUTE) * MINUTE);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function dayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatWhen(date: Date, now: Date, locale: string, t: Translate): string {
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((dayStart(date) - dayStart(now)) / 86_400_000);
  if (days === 0) return t("today", { time });
  if (days === 1) return t("tomorrow", { time });
  const weekday = date.toLocaleDateString(locale, { weekday: "short" });
  return `${weekday} ${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function formatRemaining(date: Date, now: Date, t: Translate): string {
  const minutesLeft = Math.round((date.getTime() - now.getTime()) / MINUTE);
  if (minutesLeft <= 0) return t("resetPassed");
  const days = Math.floor(minutesLeft / 1440);
  const hours = Math.floor((minutesLeft % 1440) / 60);
  const minutes = minutesLeft % 60;
  if (days > 0) return t("inDays", { days, hours });
  if (hours > 0) return t("inHours", { hours, minutes });
  return t("inMinutes", { minutes });
}

export function formatClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// daemon 给的窗口名是英文（Session / Weekly / Weekly · Fable），按窗口 id 换成 App 语言，认不出的原样显示
const LABEL_KEYS = [
  ["five_hour", "Session", "labelSession"],
  ["weekly", "Weekly", "labelWeekly"],
  ["monthly", "Monthly", "labelMonthly"],
] as const;

export function localizeLabel(id: string, label: string, t: Translate): string {
  for (const [idPrefix, englishPrefix, key] of LABEL_KEYS) {
    if (id.startsWith(idPrefix) && label.startsWith(englishPrefix)) {
      return t(key) + label.slice(englishPrefix.length);
    }
  }
  return label;
}
