import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import type { PaseoProviderUsageResult } from "@getpaseo/client";
import { useCallback, useEffect, useState } from "react";

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

export function useUsage() {
  const paseo = usePaseo();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const load = useCallback(async () => {
    try {
      const result = await paseo.providers.listUsage();
      // 拿到了但没有任何限额窗口的（如 Grok）不列出
      const providers = result.providers.filter(
        (provider) => provider.status !== "available" || provider.windows.length > 0,
      );
      setState({ kind: "ready", providers, fetchedAt: result.fetchedAt });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [paseo]);
  useEffect(() => {
    let active = true;
    const run = () => {
      if (active) void load();
    };
    run();
    const timer = setInterval(run, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);
  return { state, reload: load };
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
