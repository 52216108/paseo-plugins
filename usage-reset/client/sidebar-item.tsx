import { useTranslation, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { localizeShortLabel } from "./format";
import { messages } from "./messages";
import { PROVIDER_ICONS } from "./provider-icons";
import { UsagePopover } from "./usage-popover";
import { providerKind, remainingPct, toneColor, useUsage } from "./usage-data";

// 按模型的窗口（"wk Fable"）在侧边栏只写模型名，省掉「周」字，一行放得下
function sidebarLabel(shortLabel: string, t: Parameters<typeof localizeShortLabel>[1]): string {
  const model = shortLabel.match(/^(?:wk|mo) (.+)$/);
  return model ? model[1] : localizeShortLabel(shortLabel, t);
}

// 侧边栏：每个账户一行（挤在一行时后面的账户会被截掉），列出该账户全部限额窗口（5 小时、周、按模型的周限额），
// 显示剩余百分比并按 tone 上色；数据没到时显示一行「限额」占位
export function UsageResetSidebarItem({ theme, openPopover }: PluginSidebarItemProps) {
  const { t } = useTranslation(messages);
  const { state } = useUsage();
  const open = () => openPopover(UsagePopover);
  const providers =
    state.kind === "ready"
      ? state.providers
          .filter((provider) => provider.status === "available")
          .map((provider) => ({
            provider,
            windows: provider.windows.filter((limit) => remainingPct(limit) != null),
          }))
          .filter(({ windows }) => windows.length > 0)
      : [];
  if (providers.length === 0) {
    return <SidebarRow icon="Clock" label={t("rowLabel")} onPress={open} />;
  }
  return (
    <>
      {providers.map(({ provider, windows }) => {
        const svg = PROVIDER_ICONS[providerKind(provider.providerId)];
        return (
          <SidebarRow
            key={provider.providerId}
            id={provider.providerId.replace(/[^A-Za-z0-9_-]/g, "-")}
            icon={svg ? { svg } : "Clock"}
            // 只留图标不写名字：Claude 一行有 3 个窗口，写上名字会把图标和百分比挤掉
            label=""
            onPress={open}
            trailing={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 4 }}>
                {windows.map((limit) => (
                  <Text key={limit.id} numberOfLines={1} style={{ fontSize: 12 }}>
                    <Text style={{ color: toneColor(theme, limit.tone), fontWeight: "600" }}>
                      {`${Math.round(remainingPct(limit) ?? 0)}%`}
                    </Text>
                    <Text style={{ color: theme.colors.foregroundMuted }}>
                      {` ${sidebarLabel(limit.shortLabel ?? limit.label, t)}`}
                    </Text>
                  </Text>
                ))}
              </View>
            }
          />
        );
      })}
    </>
  );
}
