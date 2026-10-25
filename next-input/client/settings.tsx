import { Text, View } from "react-native";
import { useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/contracts";
import { messages } from "./messages";

export function PredictionSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const { t } = useTranslation(messages);
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status !== "ready") return <Text style={muted}>{t(settings.status === "loading" ? "loading" : "settingsError")}</Text>;
  return <View style={{ gap: 16, padding: 16 }}>
    <SettingsSwitch label={t("enabled")} value={settings.values.enabled}
      hint={t("enabledHint")}
      onValueChange={enabled => { void settings.save({ enabled }, settings.revision); }} />
    <Text style={muted}>{t("privacy")}</Text>
    <Text style={muted}>{t("storage")}</Text>
    {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{t("saveError")}</Text> : null}
  </View>;
}
