import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { claudeStatus, predictSuggestion, preferences, ROW_KIND, sendSuggestion, type PredictionResult, type Suggestion } from "./shared/contracts";
import { selectContext } from "./server/context";
import { generate } from "./server/generate";
import { findClaude } from "./server/claude";
import { Predictions } from "./server/predictions";
import { Turns, type Turn } from "./server/turns";
import { sendOnce } from "./server/send";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const turns = new Turns();
  const suggestions = new Map<string, Suggestion>();
  const pending = new Map<string, Turn>();
  const predictions = new Predictions<PredictionResult>();
  const consumed = new Map<string, string>();
  const clear = (id: string) => {
    turns.remove(id); pending.delete(id); predictions.remove(id); suggestions.delete(id); consumed.delete(id);
  };
  const reset = () => { turns.clear(); pending.clear(); predictions.clear(); suggestions.clear(); consumed.clear(); };
  const unsubscribe = settings.subscribe(reset);
  const removers = [
    server.on("agent.turn_started", event => {
      clear(event.agent.id);
      turns.start(event.agent.id, event.turnId);
    }),
    server.on("agent.archived", event => clear(event.agent.id)),
    server.on("agent.closed", event => clear(event.agent.id)),
    server.on("agent.turn_ended", async (event, { paseo }) => {
      const { id, workspaceId, parentAgentId } = event.agent;
      const turn = turns.end(id, event.turnId);
      if (!turn || !workspaceId || parentAgentId || event.outcome.kind !== "completed") return;
      try {
        const config = await settings.read();
        if (config.status !== "ready" || !config.values.enabled) return;
        const cli = await findClaude();
        if (!cli.path || !turns.isCurrent(id, turn)) return;
        // 等待速度行落盘追加；新回合、归档及设置变化都会取消等待。
        await delay(3500, undefined, { signal: turn.controller.signal });
        if (!turns.isCurrent(id, turn)) return;
        const row: Suggestion = { agentId: id, workspaceId, token: randomUUID(), status: "idle", text: "" };
        suggestions.set(id, row); pending.set(id, turn);
        // 此处只登记占位行，不读取对话或调用模型。
        await paseo.agents.ref(id).timeline.append({
          type: "plugin", id: `suggestion-${row.token}`, kind: ROW_KIND, version: 1, data: { ...row },
        });
      } catch { if (turns.isCurrent(id, turn)) console.error("next-input: 无法登记建议"); }
    }),
  ];
  server.handle(claudeStatus, () => findClaude());
  server.handle(predictSuggestion, ({ agentId, token }, { paseo }) => {
    const turn = pending.get(agentId);
    const current = () => !!turn && turns.isCurrent(agentId, turn) && suggestions.get(agentId)?.token === token;
    const expired: PredictionResult = { status: "expired", text: "" };
    return predictions.get(agentId, token, current, async () => {
      try {
        const config = await settings.read();
        if (!current() || config.status !== "ready" || !config.values.enabled) return expired;
        const cli = await findClaude();
        if (!cli.path) return { status: "unavailable", text: "" };
        if (!current()) return expired;
        const timeline = paseo.agents.ref(agentId).timeline;
        let page = await timeline.refetch({ direction: "tail", limit: 100, projection: "projected" });
        let entries = page.entries;
        for (let pages = 1; pages < 5 && page.hasOlder && page.startCursor; pages++) {
          if (!current()) return expired;
          if (entries.filter(e => e.item.type === "user_message").length >= 4) break;
          page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 100, projection: "projected" });
          entries = [...page.entries, ...entries];
        }
        if (!current()) return expired;
        const context = selectContext(entries, turn!.id);
        if (!context.length) return { status: "empty", text: "" };
        const model = config.values.model === "custom" ? config.values.customModel : config.values.model;
        const text = await generate(context, turn!.controller.signal, cli.path, model);
        if (!current()) return expired;
        if (!text) return { status: "empty", text: "" };
        suggestions.set(agentId, { ...suggestions.get(agentId)!, status: "ready", text });
        return { status: "ready", text };
      } catch {
        if (!current()) return expired;
        console.error("next-input: 预测失败");
        return { status: "error", text: "" };
      }
    }, expired);
  });
  server.handle(sendSuggestion, async ({ agentId, token, text }, { paseo }) => {
    await sendOnce(suggestions, consumed, agentId, token, () => paseo.agents.ref(agentId).send(text));
    return {};
  });
  return () => { for (const remove of removers) remove(); unsubscribe(); reset(); };
}
