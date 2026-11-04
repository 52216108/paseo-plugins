import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { preferences, toolsStatus, type EngineSetting } from "../shared/contracts";
import { validModelId } from "../shared/model";
import { messages } from "./messages";

type Model = "haiku" | "sonnet" | "opus" | "custom";
export function PredictionSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const { t } = useTranslation(messages);
  const checkCli = useRpc(toolsStatus);
  type Cli = { path: string | null; searched: string[] };
  const [cli, setCli] = useState<{ claude: Cli; codex: Cli } | null>(null);
  const [cliError, setCliError] = useState(false);
  const [model, setModel] = useState<Model>("haiku");
  const [custom, setCustom] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const refresh = () => { setCliError(false); void checkCli({}).then(setCli, () => setCliError(true)); };
  useEffect(refresh, [checkCli]);
  const revision = settings.status === "ready" ? settings.revision : null;
  useEffect(() => {
    if (settings.status === "ready") {
      setModel(settings.values.model); setCustom(settings.values.customModel); setCodexModel(settings.values.codexModel);
    }
  }, [revision]);
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status !== "ready") return <Text style={muted}>{t(settings.status === "loading" ? "loading" : "settingsError")}</Text>;
  const valid = ((custom === "" && model !== "custom") || validModelId(custom)) && (codexModel === "" || validModelId(codexModel));
  return <View style={{ gap: 16, padding: 16 }}>
    <SettingsSwitch label={t("enabled")} value={settings.values.enabled} hint={t("enabledHint")}
      onValueChange={enabled => { void settings.save({ ...settings.values, enabled }, settings.revision); }} />
    <SettingsSelect<EngineSetting> label={t("engine")} value={settings.values.engine} hint={t("engineHint")}
      onValueChange={engine => { void settings.save({ ...settings.values, engine }, settings.revision); }}
      options={[{ label: t("engineAuto"), value: "auto" }, { label: "Claude", value: "claude" }, { label: "Codex", value: "codex" }]} />
    <SettingsSelect<Model> label={t("model")} value={model} onValueChange={setModel}
      options={[{ label: "Haiku", value: "haiku" }, { label: "Sonnet", value: "sonnet" }, { label: "Opus", value: "opus" }, { label: t("customModel"), value: "custom" }]} />
    <SettingsInput key={revision} label={t("customModel")} initialValue={settings.values.customModel}
      onChangeText={setCustom} hint={t("modelHint")} error={(custom === "" && model !== "custom") || validModelId(custom) ? null : t("invalidModel")} />
    <SettingsInput key={`codex-${revision}`} label={t("codexModel")} initialValue={settings.values.codexModel}
      onChangeText={setCodexModel} hint={t("codexModelHint")} error={codexModel === "" || validModelId(codexModel) ? null : t("invalidModel")} />
    <SettingsSwitch label={t("codexFast")} value={settings.values.codexFast} hint={t("codexFastHint")}
      onValueChange={codexFast => { void settings.save({ ...settings.values, codexFast }, settings.revision); }} />
    <SettingsAction label={t("model")} actionLabel={t("saveModel")} disabled={!valid}
      onPress={() => { void settings.save({ ...settings.values, model, customModel: custom, codexModel }, settings.revision); }} />
    {cliError ? <Text style={muted}>{t("cliError")}</Text> : cli ? <>
      <Text style={muted}>{t(cli.claude.path ? "cliFound" : "cliMissing")}</Text>
      <Text selectable style={muted}>{cli.claude.path ?? cli.claude.searched.join("\n")}</Text>
      <Text style={muted}>{t(cli.codex.path ? "codexFound" : "codexMissing")}</Text>
      <Text selectable style={muted}>{cli.codex.path ?? cli.codex.searched.join("\n")}</Text>
    </> : <Text style={muted}>{t("loading")}</Text>}
    <SettingsAction label={t("cli")} actionLabel={t("checkAgain")} onPress={refresh} />
    <Text style={muted}>{t("privacy")}</Text>
    <Text style={muted}>{t("storage")}</Text>
    {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{t("saveError")}</Text> : null}
  </View>;
}
