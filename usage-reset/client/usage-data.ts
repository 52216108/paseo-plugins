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

// 上色看「按现在的速度，刷新前会不会用完」，不看剩余百分比本身：
// 周限额剩 12% 但 7 小时后就刷新，其实够用；5 小时限额剩 50% 但才过 1 小时，反而要当心。
// 平时一律蓝色，只有可能撑不到刷新时才变橙、变红，颜色一出现就值得看一眼。
// 用固定的明亮色，不取主题的状态色：有的主题状态色偏暗，铺满一整条进度条显得发闷
const PACE_COLORS = { ok: "#4A9DF8", warning: "#FF9F0A", danger: "#FF5A50" } as const;
type PaceLevel = keyof typeof PACE_COLORS;

const HOUR = 3_600_000;
// daemon 不给窗口时长，按窗口 id 推（Codex 的 id 也是 daemon 按上报时长归一出来的）
const WINDOW_LENGTHS: ReadonlyArray<readonly [string, number]> = [
  ["five_hour", 5 * HOUR],
  ["weekly", 7 * 24 * HOUR],
  ["monthly", 30 * 24 * HOUR],
];
// 窗口刚开头用量数据太少，速度估不准，先按剩余百分比看
const MIN_ELAPSED_RATIO = 0.15;

function paceLevel(limit: UsageWindow, now: Date): PaceLevel | null {
  const left = remainingPct(limit);
  if (left == null) return null;
  if (left <= 0) return "danger";
  const length = WINDOW_LENGTHS.find(([prefix]) => limit.id.startsWith(prefix))?.[1];
  const untilReset = limit.resetsAt ? Date.parse(limit.resetsAt) - now.getTime() : NaN;
  if (length != null && untilReset > 0 && length - untilReset >= length * MIN_ELAPSED_RATIO) {
    const used = 100 - left;
    // 剩得极少时一次大任务就能用光，不管速度至少提醒
    const floor: PaceLevel = left < 5 ? "warning" : "ok";
    if (used <= 0) return floor;
    // 按目前的平均速度还能撑多久，跟离刷新还有多久比
    const ratio = left / (used / (length - untilReset)) / untilReset;
    if (ratio < 0.5) return "danger";
    if (ratio < 1) return "warning";
    return floor;
  }
  if (left < 10) return "danger";
  if (left < 30) return "warning";
  return "ok";
}

export function remainingColor(theme: PluginTheme, limit: UsageWindow, now: Date): string {
  const level = paceLevel(limit, now);
  return level ? PACE_COLORS[level] : theme.colors.foregroundMuted;
}
