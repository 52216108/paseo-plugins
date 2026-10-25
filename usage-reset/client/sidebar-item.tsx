import { useTranslation, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { localizeShortLabel } from "./format";
import { messages } from "./messages";
import { PROVIDER_ICONS } from "./provider-icons";
import { UsagePopover } from "./usage-popover";
import { providerKind, remainingPct, toneColor, useUsage } from "./usage-data";

// "Claude (someone@example.com)" → "Claude"，侧边栏放不下账户名
function shortName(displayName: string): string {
  return displayName.replace(/\s*\(.*\)\s*$/, "") || displayName;
}

// 侧边栏：每个账户一行（挤在一行时后面的账户会被截掉），跟自带用量行一样只列 summary 窗口（5 小时、周），
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
            windows: provider.windows.filter((limit) => limit.summary && remainingPct(limit) != null),
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
            label={shortName(provider.displayName)}
            onPress={open}
            trailing={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 4 }}>
                {windows.map((limit) => (
                  <Text key={limit.id} numberOfLines={1} style={{ fontSize: 12 }}>
                    <Text style={{ color: toneColor(theme, limit.tone), fontWeight: "600" }}>
                      {`${Math.round(remainingPct(limit) ?? 0)}%`}
                    </Text>
                    <Text style={{ color: theme.colors.foregroundMuted }}>
                      {` ${localizeShortLabel(limit.shortLabel ?? limit.label, t)}`}
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
