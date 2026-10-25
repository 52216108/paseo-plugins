import { useEffect, useState } from "react";
import { useAgent, useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { SuggestionEditor } from "./client/editor";
import { PredictionSettings } from "./client/settings";
import { messages } from "./client/messages";
import { Drafts } from "./client/drafts";
import { predictSuggestion, ROW_KIND, suggestionSchema, type PredictionResult, type Suggestion } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "preferences", title: messages.message("title"), icon: "Sparkles", Component: PredictionSettings });
  const drafts = new Drafts();
  function Row(props: PluginTimelineItemProps<Suggestion>) {
    const status = useAgent(props.agentId, agent => agent.status);
    const predict = useRpc(predictSuggestion);
    const [result, setResult] = useState<PredictionResult | null>(null);
    const [expired, setExpired] = useState(false);
    useEffect(() => {
      // 已展示的建议一旦观察到新回合，即永久失效，不会在回到 idle 后恢复。
      if (status === "running" && result) setExpired(true);
    }, [status, result]);
    useEffect(() => {
      if (status !== "idle" || expired) return;
      let mounted = true;
      void predict({ agentId: props.agentId, token: props.item.data.token })
        .then(value => { if (mounted) setResult(value); }, () => {
          if (mounted) setResult({ status: "error", text: "" });
        });
      return () => { mounted = false; };
    }, [props.agentId, props.item.data.token, predict, status, expired]);
    const saved = drafts.edited(props.item.data.token);
    if ((saved && result?.status !== "ready") || !result || !["ready", "error"].includes(result.status)) {
      return saved ? <SuggestionEditor {...props} drafts={drafts} current={false}
        item={{ ...props.item, data: { ...props.item.data, status: "ready", text: saved.sourceText } }} /> : null;
    }
    return <SuggestionEditor {...props} drafts={drafts}
      item={{ ...props.item, data: { ...props.item.data, status: result.status === "ready" ? "ready" : "error", text: result.text } }}
      current={!expired && status === "idle"} />;
  }
  client.addTimelineRenderer({ kind: ROW_KIND, version: 1, schema: suggestionSchema, Component: Row });
  return () => drafts.clear();
}
