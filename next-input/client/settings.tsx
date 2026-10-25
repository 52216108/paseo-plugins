import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { claudeStatus, preferences } from "../shared/contracts";
import { validModelId } from "../shared/model";
import { messages } from "./messages";

type Model = "haiku" | "sonnet" | "opus" | "custom";
export function PredictionSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const { t } = useTranslation(messages);
  const checkCli = useRpc(claudeStatus);
  const [cli, setCli] = useState<{ path: string | null; searched: string[] } | null>(null);
  const [cliError, setCliError] = useState(false);
  const [model, setModel] = useState<Model>("haiku");
  const [custom, setCustom] = useState("");
  const refresh = () => { setCliError(false); void checkCli({}).then(setCli, () => setCliError(true)); };
  useEffect(refresh, [checkCli]);
  const revision = settings.status === "ready" ? settings.revision : null;
  useEffect(() => {
    if (settings.status === "ready") { setModel(settings.values.model); setCustom(settings.values.customModel); }
  }, [revision]);
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status !== "ready") return <Text style={muted}>{t(settings.status === "loading" ? "loading" : "settingsError")}</Text>;
  const valid = (custom === "" && model !== "custom") || validModelId(custom);
  return <View style={{ gap: 16, padding: 16 }}>
    <SettingsSwitch label={t("enabled")} value={settings.values.enabled} hint={t("enabledHint")}
      onValueChange={enabled => { void settings.save({ ...settings.values, enabled }, settings.revision); }} />
    <SettingsSelect<Model> label={t("model")} value={model} onValueChange={setModel}
      options={[{ label: "Haiku", value: "haiku" }, { label: "Sonnet", value: "sonnet" }, { label: "Opus", value: "opus" }, { label: t("customModel"), value: "custom" }]} />
    <SettingsInput key={revision} label={t("customModel")} initialValue={settings.values.customModel}
      onChangeText={setCustom} hint={t("modelHint")} error={valid ? null : t("invalidModel")} />
    <SettingsAction label={t("model")} actionLabel={t("saveModel")} disabled={!valid}
      onPress={() => { void settings.save({ ...settings.values, model, customModel: custom }, settings.revision); }} />
    {cliError ? <Text style={muted}>{t("cliError")}</Text> : cli ? <>
      <Text style={muted}>{t(cli.path ? "cliFound" : "cliMissing")}</Text>
      <Text selectable style={muted}>{cli.path ?? cli.searched.join("\n")}</Text>
    </> : <Text style={muted}>{t("loading")}</Text>}
    <SettingsAction label={t("cli")} actionLabel={t("checkAgain")} onPress={refresh} />
    <Text style={muted}>{t("privacy")}</Text>
    <Text style={muted}>{t("storage")}</Text>
    {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{t("saveError")}</Text> : null}
  </View>;
}
