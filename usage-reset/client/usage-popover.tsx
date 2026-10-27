import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation, type PluginPopoverProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { formatClock, formatRemaining, formatWhen, localizeLabel, roundToMinute } from "./format";
import { messages, type Translate } from "./messages";
import { PROVIDER_ICONS } from "./provider-icons";
import {
  barColor,
  providerKind,
  remainingPct,
  useHiddenWindows,
  useNow,
  useUsage,
  type ProviderUsage,
  type UsageWindow,
} from "./usage-data";

const SEGMENTS = 40;

function makeStyles(theme: PluginTheme, compact: boolean) {
  return {
    root: { padding: compact ? 16 : 14, gap: 12, minWidth: 340 },
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
    card: {
      padding: 14,
      gap: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    divider: { height: 1, backgroundColor: theme.colors.border },
    provider: { gap: 12 },
    providerHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    providerName: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const, flexShrink: 1 },
    plan: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: theme.colors.surface2,
    },
    planText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600" as const,
      letterSpacing: 1,
    },
    window: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
    windowBody: { flex: 1, gap: 5 },
    windowTop: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
    windowLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
    pctLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
    pct: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" as const },
    bar: { flexDirection: "row" as const, gap: 2, height: 16 },
    segment: { flex: 1, borderRadius: 2 },
    resetRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
    when: { color: theme.colors.foreground, fontSize: 12, fontWeight: "500" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
    eye: { padding: 4 },
  };
}

type Styles = ReturnType<typeof makeStyles>;

// 分段进度条：亮色格子数 = 剩余百分比，其余格子同色淡显
function SegmentBar({ pct, color, styles }: { pct: number; color: string; styles: Styles }) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * SEGMENTS);
  return (
    <View style={styles.bar}>
      {Array.from({ length: SEGMENTS }, (_, index) => (
        <View
          key={index}
          style={[styles.segment, { backgroundColor: color, opacity: index < filled ? 1 : 0.2 }]}
        />
      ))}
    </View>
  );
}

function WindowRow({
  provider,
  limit,
  hidden,
  onToggle,
  canToggle,
  now,
  theme,
  styles,
}: {
  provider: ProviderUsage;
  limit: UsageWindow;
  hidden: boolean;
  onToggle: () => void;
  canToggle: boolean;
  now: Date;
  theme: PluginTheme;
  styles: Styles;
}) {
  const { t, locale } = useTranslation(messages);
  const resetsAt = limit.resetsAt ? roundToMinute(limit.resetsAt) : null;
  const left = remainingPct(limit);
  return (
    <View style={styles.window}>
      <View style={styles.windowBody}>
        <View style={styles.windowTop}>
          <Text style={styles.windowLabel}>{localizeLabel(limit.id, limit.label, t)}</Text>
          {left != null ? (
            <Text style={styles.pctLabel}>
              {t("remainingLabel")}
              <Text style={styles.pct}>{`  ${Math.round(left)}%`}</Text>
            </Text>
          ) : null}
        </View>
        {left != null ? (
          <SegmentBar pct={left} color={barColor(theme, provider.providerId, limit.tone)} styles={styles} />
        ) : null}
        <View style={styles.resetRow}>
          <Icon name="History" size={13} color={theme.colors.foregroundMuted} />
          {resetsAt ? (
            <Text style={styles.muted}>
              <Text style={styles.when}>{t("resetsAt", { when: formatWhen(resetsAt, now, locale, t) })}</Text>
              {` · ${formatRemaining(resetsAt, now, t)}`}
            </Text>
          ) : (
            <Text style={styles.muted}>{t("noReset")}</Text>
          )}
        </View>
      </View>
      {left != null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(hidden ? "showInSidebar" : "hideFromSidebar")}
          disabled={!canToggle}
          onPress={onToggle}
          style={styles.eye}
        >
          <Icon
            name={hidden ? "EyeOff" : "Eye"}
            size={18}
            color={hidden ? theme.colors.foregroundMuted : theme.colors.foreground}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

function ProviderSection({
  provider,
  now,
  theme,
  styles,
  t,
  sidebar,
}: {
  provider: ProviderUsage;
  now: Date;
  theme: PluginTheme;
  styles: Styles;
  t: Translate;
  sidebar: ReturnType<typeof useHiddenWindows>;
}) {
  const { isHidden, toggle, ready } = sidebar;
  const svg = PROVIDER_ICONS[providerKind(provider.providerId)];
  return (
    <View style={styles.provider}>
      <View style={styles.providerHeader}>
        {svg ? <Icon icon={{ svg }} size={22} color={theme.colors.foreground} /> : null}
        <Text style={styles.providerName} numberOfLines={1}>
          {provider.displayName}
        </Text>
        {provider.planLabel ? (
          <View style={styles.plan}>
            <Text style={styles.planText}>{provider.planLabel.toUpperCase()}</Text>
          </View>
        ) : null}
      </View>
      {provider.status !== "available" ? (
        <Text style={styles.muted}>{provider.error ?? t("unavailable")}</Text>
      ) : (
        provider.windows.map((limit) => (
          <WindowRow
            key={limit.id}
            provider={provider}
            limit={limit}
            hidden={isHidden(provider.providerId, limit.id)}
            onToggle={() => toggle(provider.providerId, limit.id)}
            canToggle={ready}
            now={now}
            theme={theme}
            styles={styles}
          />
        ))
      )}
    </View>
  );
}

export function UsagePopover({ theme, layout }: PluginPopoverProps) {
  const { t } = useTranslation(messages);
  const { state, reload } = useUsage();
  const now = useNow(30_000);
  const sidebar = useHiddenWindows();
  // 打开时拉一次最新的；数据与侧边栏共用，侧边栏会同步更新
  useEffect(() => {
    void reload();
  }, [reload]);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);

  let body;
  if (state.kind === "loading") {
    body = <Text style={styles.muted}>{t("loading")}</Text>;
  } else if (state.kind === "error") {
    body = <Text style={[styles.muted, { color: theme.colors.statusDanger }]}>{t("error", { message: state.message })}</Text>;
  } else if (state.providers.length === 0) {
    body = <Text style={styles.muted}>{t("empty")}</Text>;
  } else {
    body = (
      <View style={styles.card}>
        {state.providers.map((provider, index) => (
          <Fragment key={provider.providerId}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <ProviderSection provider={provider} now={now} theme={theme} styles={styles} t={t} sidebar={sidebar} />
          </Fragment>
        ))}
      </View>
    );
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
