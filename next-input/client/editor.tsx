import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useTranslation, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { sendSuggestion, type Suggestion } from "../shared/contracts";
import { messages } from "./messages";
import type { Draft, Drafts } from "./drafts";

export function SuggestionEditor({ item, theme, current, drafts }: PluginTimelineItemProps<Suggestion> & { current: boolean; drafts: Drafts }) {
  const row = item.data;
  const { t } = useTranslation(messages);
  const [draft, setDraft] = useState(() => drafts.get(row.token, row.text));
  const { text, expanded, sent, attempted, notice } = draft;
  const update = (patch: Partial<Draft>) => setDraft(drafts.update(row.token, row.text, patch));
  const [busy, setBusy] = useState(false);
  const send = useRpc(sendSuggestion);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const action = { padding: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 };
  async function submit() {
    if (!current || busy || attempted || !text.trim()) return;
    setBusy(true); update({ attempted: true, notice: "" });
    try { await send({ agentId: row.agentId, token: row.token, text: text.trim() }); update({ sent: true }); }
    catch { update({ notice: t("sendFailed") }); }
    finally { setBusy(false); }
  }
  if (sent || (!current && !(expanded && text !== row.text))) return null;
  return <View style={{ gap: 8, alignSelf: "stretch", paddingVertical: 4 }}>
    {!expanded && row.status === "ready" ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("suggestion", { text: row.text })}
        onPress={() => update({ expanded: true })} style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{row.text}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("sendSuggestion")} disabled={!current || busy || attempted}
        onPress={() => { void submit(); }} style={{ width: 44, height: 44, flexShrink: 0,
          alignItems: "center", justifyContent: "center", opacity: !current || busy || attempted ? 0.5 : 1 }}>
        {busy ? <Text style={muted}>…</Text> : <Icon name="Send" size={14} color={theme.colors.foregroundMuted} />}
      </Pressable>
    </View> : <>
    {row.status === "ready" ? <>
      <Text style={muted}>{t(current ? "hint" : "stale")}</Text>
      <TextInput accessibilityLabel={t("edit")} multiline value={text} onChangeText={text => update({ text })} maxLength={2000}
        editable={!busy} style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1,
          borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, minHeight: 96 }} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("copy")} disabled={busy}
          style={action} onPress={() => { void copyText(text).then(() => update({ notice: t("copied") }), () => update({ notice: t("copyFailed") })); }}>
          <Text style={{ color: theme.colors.foreground }}>{t("copy")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("send")} disabled={!current || busy || attempted || !text.trim()}
          style={{ ...action, opacity: !current || busy || attempted || !text.trim() ? 0.5 : 1 }} onPress={() => { void submit(); }}>
          <Text style={{ color: theme.colors.foreground }}>{t(busy ? "sending" : "send")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} style={action} onPress={() => { update({ text: row.text, expanded: false }); }}>
          <Text style={{ color: theme.colors.foreground }}>{t("cancel")}</Text>
        </Pressable>
      </View>
    </> : <Text style={muted}>{t("unavailable")}</Text>}
    </>}
    {notice ? <Text accessibilityRole="alert" style={muted}>{notice}</Text> : null}
  </View>;
}
