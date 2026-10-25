import { useTranslation, type PluginPopoverProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { formatClock, formatRemaining, formatWhen, localizeLabel, roundToMinute } from "./format";
import { messages } from "./messages";
import { remainingPct, toneColor, useNow, useUsage } from "./usage-data";

export function UsagePopover({ theme, layout }: PluginPopoverProps) {
  const { t, locale } = useTranslation(messages);
  const { state, reload } = useUsage();
  const now = useNow(30_000);
  const styles = useMemo(
    () => ({
      root: { padding: layout.compact ? 16 : 14, gap: 12, minWidth: 300 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const, flex: 1 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      provider: { gap: 6 },
      providerName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      plan: { color: theme.colors.foregroundMuted, fontWeight: "400" as const },
      window: {
        gap: 2,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      windowTop: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      windowLabel: { color: theme.colors.foreground, fontSize: 13 },
      pct: { fontSize: 12, fontWeight: "600" as const },
      when: { color: theme.colors.foreground, fontSize: 13, fontWeight: "500" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  let body;
  if (state.kind === "loading") {
    body = <Text style={styles.muted}>{t("loading")}</Text>;
  } else if (state.kind === "error") {
    body = <Text style={[styles.muted, { color: theme.colors.statusDanger }]}>{t("error", { message: state.message })}</Text>;
  } else if (state.providers.length === 0) {
    body = <Text style={styles.muted}>{t("empty")}</Text>;
  } else {
    body = state.providers.map((provider) => (
      <View key={provider.providerId} style={styles.provider}>
        <Text style={styles.providerName}>
          {provider.displayName}
          {provider.planLabel ? <Text style={styles.plan}>{`  ${provider.planLabel}`}</Text> : null}
        </Text>
        {provider.status !== "available" ? (
          <Text style={styles.muted}>{provider.error ?? t("unavailable")}</Text>
        ) : (
          provider.windows.map((limit) => {
            const resetsAt = limit.resetsAt ? roundToMinute(limit.resetsAt) : null;
            const left = remainingPct(limit);
            return (
              <View key={limit.id} style={styles.window}>
                <View style={styles.windowTop}>
                  <Text style={styles.windowLabel}>{localizeLabel(limit.id, limit.label, t)}</Text>
                  {left != null ? (
                    <Text style={[styles.pct, { color: toneColor(theme, limit.tone) }]}>
                      {t("remaining", { pct: Math.round(left) })}
                    </Text>
                  ) : null}
                </View>
                {resetsAt ? (
                  <Text style={styles.muted}>
                    <Text style={styles.when}>{t("resetsAt", { when: formatWhen(resetsAt, now, locale, t) })}</Text>
                    {` · ${formatRemaining(resetsAt, now, t)}`}
                  </Text>
                ) : (
                  <Text style={styles.muted}>{t("noReset")}</Text>
                )}
              </View>
            );
          })
        )}
      </View>
    ));
  }

  const fetchedClock = state.kind === "ready" ? formatClock(state.fetchedAt) : null;
  return (
    <ScrollView>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>{t("title")}</Text>
          {fetchedClock ? <Text style={styles.muted}>{t("fetchedAt", { time: fetchedClock })}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
            onPress={() => void reload()}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{t("retry")}</Text>
          </Pressable>
        </View>
        {body}
      </View>
    </ScrollView>
  );
}
