import { useSyncExternalStore } from "react";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { SuggestionEditor } from "./client/editor";
import { PredictionSettings } from "./client/settings";
import { messages } from "./client/messages";
import { Drafts } from "./client/drafts";
import { listSuggestions, ROW_KIND, suggestionSchema, type Suggestion } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "preferences", title: messages.message("title"), icon: "Sparkles", Component: PredictionSettings });
  // 每个插件安装实例各有一份状态，不跨 host 共用缓存。
  let latest = new Map<string, string>();
  const drafts = new Drafts();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function Row(props: PluginTimelineItemProps<Suggestion>) {
    const token = useSyncExternalStore(subscribe, () => latest.get(props.agentId) ?? "");
    return <SuggestionEditor {...props} drafts={drafts} current={token === props.item.data.token} />;
  }
  client.addTimelineRenderer({ kind: ROW_KIND, version: 1, schema: suggestionSchema, Component: Row });
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    try {
      const { items } = await client.rpc(listSuggestions, {});
      if (disposed) return;
      latest = new Map(items.filter(row => row.status !== "loading").map(row => [row.agentId, row.token]));
      for (const listener of listeners) listener();
    } catch { /* 短暂断线保留原地编辑内容，发送时仍由服务端检查 token。 */ }
    finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 1500); }
  }
  void poll();
  return () => { disposed = true; clearTimeout(timer); listeners.clear(); latest.clear(); drafts.clear(); };
}
