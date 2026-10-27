import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { sidebarPrefs, windowKey } from "../shared/settings";

// 类型都从插件 SDK 推导，不直接引 @getpaseo/client：从 Git 安装时没有 node_modules，daemon 只提供 SDK 本身
type PaseoApi = ReturnType<typeof usePaseo>;
type PaseoProviderUsageResult = Awaited<ReturnType<PaseoApi["providers"]["listUsage"]>>;

export type ProviderUsage = PaseoProviderUsageResult["providers"][number];
export type UsageWindow = ProviderUsage["windows"][number];

export type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; providers: ProviderUsage[]; fetchedAt: string };

const REFRESH_MS = 5 * 60_000;

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// 每台主机一份用量数据，侧边栏和弹出层共用：任何一处拉到新数据，所有地方同时更新，
// 只要还有组件在看就由同一个定时器轮询
class UsageStore {
  private state: LoadState = { kind: "loading" };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(private readonly paseo: PaseoApi) {}

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      void this.load();
      this.timer = setInterval(() => void this.load(), REFRESH_MS);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };

  load = async () => {
    // 并发请求只认最后发出的那个，避免旧响应后到把新数据盖回去
    const seq = ++this.seq;
    let next: LoadState;
    try {
      const result = await this.paseo.providers.listUsage();
      // 拿到了但没有任何限额窗口的（如 Grok）不列出
      const providers = result.providers.filter(
        (provider) => provider.status !== "available" || provider.windows.length > 0,
      );
      next = { kind: "ready", providers, fetchedAt: result.fetchedAt };
    } catch (error) {
      // 已有数据时一次失败不清空，保留上一份
      if (this.state.kind === "ready") return;
      next = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    if (seq !== this.seq) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  };
}

const stores = new WeakMap<PaseoApi, UsageStore>();

function storeFor(paseo: PaseoApi): UsageStore {
  let store = stores.get(paseo);
  if (!store) {
    store = new UsageStore(paseo);
    stores.set(paseo, store);
  }
  return store;
}

export function useUsage() {
  const store = storeFor(usePaseo());
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { state, reload: store.load };
}

export function remainingPct(limit: UsageWindow): number | null {
  if (limit.remainingPct != null) return limit.remainingPct;
  if (limit.usedPct != null) return 100 - limit.usedPct;
  return null;
}

// 提供方 id 形如 "claude" 或 "claude:<账户>"，取冒号前的部分对应图标
export function providerKind(providerId: string): string {
  return providerId.split(":")[0];
}

// 侧边栏隐藏了哪些窗口；设置还没读到时当作全部显示
export function useHiddenWindows() {
  const settings = useSettings(sidebarPrefs);
  const hidden = settings.status === "ready" ? settings.values.hidden : [];
  const isHidden = useCallback(
    (providerId: string, windowId: string) => hidden.includes(windowKey(providerId, windowId)),
    [hidden],
  );
  const toggle = useCallback(
    (providerId: string, windowId: string) => {
      if (settings.status !== "ready") return;
      const key = windowKey(providerId, windowId);
      const current = settings.values.hidden;
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      void settings.save({ hidden: next }, settings.revision);
    },
    [settings],
  );
  return { isHidden, toggle, ready: settings.status === "ready" };
}

// 进度条只表示剩余多少，统一一种颜色；预算紧不紧由「日均可用」单独表示
export const BAR_COLOR = "#4A9DF8";

// 日均可用 = 剩余额度 ÷ 离刷新还有几份时间（周、月按天，5 小时按小时），跟平均分的标准额度比：
// 周限额每天约 14%，5 小时每小时 20%，月限额每天约 3.3%。
// 不低于标准的 85% 算够用，低于 85% 偏紧，不到一半很紧（留 15% 余量，免得差一点也变色）
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// daemon 不给窗口时长，按窗口 id 推（Codex 的 id 也是 daemon 按上报时长归一出来的）
const WINDOW_BUDGETS: ReadonlyArray<readonly [string, number, "day" | "hour"]> = [
  ["five_hour", 5 * HOUR, "hour"],
  ["weekly", 7 * DAY, "day"],
  ["monthly", 30 * DAY, "day"],
];

export type BudgetLevel = "ok" | "warning" | "danger";

export interface Budget {
  unit: "day" | "hour";
  perUnitPct: number;
  level: BudgetLevel;
}

export function windowBudget(limit: UsageWindow, now: Date): Budget | null {
  const left = remainingPct(limit);
  const budget = WINDOW_BUDGETS.find(([prefix]) => limit.id.startsWith(prefix));
  const untilReset = limit.resetsAt ? Date.parse(limit.resetsAt) - now.getTime() : NaN;
  if (left == null || !budget || !(untilReset > 0)) return null;
  const [, length, unit] = budget;
  const unitMs = unit === "day" ? DAY : HOUR;
  // 离刷新不到一份时间时，剩下的就是这一份可用的，没必要再算
  if (untilReset <= unitMs) return null;
  const perUnitPct = Math.max(0, left) / (untilReset / unitMs);
  const ratio = perUnitPct / ((unitMs / length) * 100);
  const level: BudgetLevel = ratio < 0.5 ? "danger" : ratio < 0.85 ? "warning" : "ok";
  return { unit, perUnitPct, level };
}

// 文字用的颜色比进度条深一档，浅色背景上也看得清
const BUDGET_TEXT_COLORS: Record<BudgetLevel, string> = {
  ok: "#1F9D55",
  warning: "#E08600",
  danger: "#E5484D",
};

export function budgetColor(level: BudgetLevel): string {
  return BUDGET_TEXT_COLORS[level];
}
