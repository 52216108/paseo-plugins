import { useTranslation, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { localizeShortLabel } from "./format";
import { messages } from "./messages";
import { PROVIDER_ICONS } from "./provider-icons";
import { UsagePopover } from "./usage-popover";
import { providerKind, remainingPct, toneColor, useUsage } from "./usage-data";

// 侧边栏这一行：跟自带用量行一样只列 summary 窗口（5 小时、周），但显示剩余百分比并按 tone 上色
export function UsageResetSidebarItem({ theme, openPopover }: PluginSidebarItemProps) {
  const { t } = useTranslation(messages);
  const { state } = useUsage();
  const providers =
    state.kind === "ready"
      ? state.providers
          .filter((provider) => provider.status === "available")
          .map((provider) => ({
            provider,
            windows: provider.windows.filter((limit) => limit.summary && remainingPct(limit) != null),
          }))
          .filter(({ windows }) => windows.length > 0)
      : [];
  const trailing =
    providers.length > 0 ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 4 }}>
        {providers.map(({ provider, windows }) => {
          const svg = PROVIDER_ICONS[providerKind(provider.providerId)];
          return (
            <View key={provider.providerId} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {svg ? <Icon icon={{ svg }} size={12} color={theme.colors.foregroundMuted} /> : null}
              {windows.map((limit) => (
                <Text key={limit.id} style={{ fontSize: 12 }}>
                  <Text style={{ color: toneColor(theme, limit.tone), fontWeight: "600" }}>
                    {`${Math.round(remainingPct(limit) ?? 0)}%`}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted }}>
                    {` ${localizeShortLabel(limit.shortLabel ?? limit.label, t)}`}
                  </Text>
                </Text>
              ))}
            </View>
          );
        })}
      </View>
    ) : null;
  return (
    <SidebarRow
      icon="Clock"
      label={t("rowLabel")}
      trailing={trailing}
      onPress={() => openPopover(UsagePopover)}
    />
  );
}
