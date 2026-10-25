import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useTranslation, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { sendSuggestion, type Suggestion } from "../shared/contracts";
import { messages } from "./messages";
import { requiresEditing } from "../shared/safety";
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
  const restricted = requiresEditing(row.text);
  const needsEdit = restricted && text.trim() === row.text;
  async function submit() {
    if (!current || busy || attempted || needsEdit || !text.trim()) return;
    setBusy(true); update({ attempted: true, notice: "" });
    try { await send({ agentId: row.agentId, token: row.token, text: text.trim() }); update({ sent: true }); }
    catch { update({ notice: t("sendFailed") }); }
    finally { setBusy(false); }
  }
  if (sent || (!current && !(expanded && text !== row.text))) return null;
  // Paseo 0.13 的独立时间线行间隔为 16px；收起时抵消，让建议紧接上一行元信息。
  return <View style={{ gap: 8, alignSelf: "stretch", paddingVertical: 4, marginTop: expanded ? 0 : -16 }}>
    {!expanded && row.status === "ready" ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("suggestion", { text: row.text })}
        onPress={() => update({ expanded: true })} style={{ flexShrink: 1, minWidth: 0, zIndex: 1 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>✨ {row.text}</Text>
      </Pressable>
      {!restricted ? <Pressable accessibilityRole="button" accessibilityLabel={t("sendSuggestion")} disabled={!current || busy || attempted}
        hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
        onPress={() => { void submit(); }} style={{ flexShrink: 0,
          alignItems: "center", justifyContent: "center", opacity: !current || busy || attempted ? 0.5 : 1 }}>
        {busy ? <Text style={muted}>…</Text> : <Icon name="Send" size={14} color={theme.colors.foregroundMuted} />}
      </Pressable> : null}
    </View> : <>
    {row.status === "ready" ? <>
      <Text style={muted}>{t(!current ? "stale" : needsEdit ? "needsEdit" : "hint")}</Text>
      <TextInput accessibilityLabel={t("edit")} multiline value={text} onChangeText={text => update({ text })} maxLength={2000}
        editable={!busy} style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1,
          borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, minHeight: 96 }} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("copy")} disabled={busy}
          style={action} onPress={() => { void copyText(text).then(() => update({ notice: t("copied") }), () => update({ notice: t("copyFailed") })); }}>
          <Text style={{ color: theme.colors.foreground }}>{t("copy")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("send")} disabled={!current || busy || attempted || needsEdit || !text.trim()}
          style={{ ...action, opacity: !current || busy || attempted || needsEdit || !text.trim() ? 0.5 : 1 }} onPress={() => { void submit(); }}>
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
