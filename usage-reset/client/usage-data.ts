import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import type { PaseoApi, PaseoProviderUsageResult } from "@getpaseo/client";
import { useEffect, useState, useSyncExternalStore } from "react";

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

// 跟 daemon 给的 tone 走：充足绿、接近上限黄、见底红
export function toneColor(theme: PluginTheme, tone: UsageWindow["tone"]): string {
  if (tone === "danger") return theme.colors.statusDanger;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "ok") return theme.colors.statusSuccess;
  return theme.colors.foregroundMuted;
}

// 提供方 id 形如 "claude" 或 "claude:<账户>"，取冒号前的部分对应图标
export function providerKind(providerId: string): string {
  return providerId.split(":")[0];
}
