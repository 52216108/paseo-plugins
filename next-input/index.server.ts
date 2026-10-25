import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listSuggestions, preferences, ROW_KIND, sendSuggestion, type Suggestion } from "./shared/contracts";
import { selectContext } from "./server/context";
import { generate } from "./server/generate";
import { Turns } from "./server/turns";
import { sendOnce } from "./server/send";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const turns = new Turns();
  const suggestions = new Map<string, Suggestion>();
  const consumed = new Map<string, string>();
  const clear = (id: string) => { turns.remove(id); suggestions.delete(id); consumed.delete(id); };
  const unsubscribe = settings.subscribe(() => { turns.clear(); suggestions.clear(); consumed.clear(); });
  const removers = [
    server.on("agent.turn_started", event => {
      suggestions.delete(event.agent.id);
      consumed.delete(event.agent.id);
      turns.start(event.agent.id, event.turnId);
    }),
    server.on("agent.archived", event => clear(event.agent.id)),
    server.on("agent.closed", event => clear(event.agent.id)),
    server.on("agent.turn_ended", async (event, { paseo }) => {
      const { id, workspaceId, parentAgentId } = event.agent;
      const turn = turns.end(id, event.turnId);
      if (!turn || !workspaceId || parentAgentId || event.outcome.kind !== "completed") return;
      const current = () => turns.isCurrent(id, turn);
      const publish = async (row: Suggestion) => {
        if (!current()) return;
        suggestions.set(id, row);
        await paseo.agents.ref(id).timeline.append({
          type: "plugin", id: `suggestion-${row.token}`, kind: ROW_KIND, version: 1, data: { ...row },
        });
      };
      try {
        const config = await settings.read();
        if (!current() || config.status !== "ready" || !config.values.enabled) return;
        const row: Suggestion = { agentId: id, workspaceId, token: randomUUID(), status: "loading", text: "" };
        suggestions.set(id, row);
        const timeline = paseo.agents.ref(id).timeline;
        let page = await timeline.refetch({ direction: "tail", limit: 100, projection: "projected" });
        let entries = page.entries;
        for (let pages = 1; pages < 5 && page.hasOlder && page.startCursor; pages++) {
          if (!current()) return;
          if (entries.filter(e => e.item.type === "user_message").length >= 4) break;
          page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 100, projection: "projected" });
          entries = [...page.entries, ...entries];
        }
        if (!current()) return;
        const messages = selectContext(entries, event.turnId);
        if (!messages.length) { suggestions.delete(id); return; }
        const text = await generate(messages, turn.controller.signal);
        if (!current()) return;
        if (text) await publish({ ...row, status: "ready", text });
        else suggestions.delete(id);
      } catch {
        if (!current()) return;
        const row = suggestions.get(id);
        if (row) await publish({ ...row, status: "error", text: "" }).catch(() => {});
        // 不记录对话、模型输出、账户信息或 CLI 原始报错。
        console.error("next-input: 预测失败");
      }
    }),
  ];
  server.handle(listSuggestions, () => ({ items: [...suggestions.values()] }));
  server.handle(sendSuggestion, async ({ agentId, token, text }, { paseo }) => {
    await sendOnce(suggestions, consumed, agentId, token, () => paseo.agents.ref(agentId).send(text));
    return {};
  });
  return () => { for (const remove of removers) remove(); unsubscribe(); turns.clear(); suggestions.clear(); consumed.clear(); };
}
