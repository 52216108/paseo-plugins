import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation, type PluginPopoverProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { formatClock, formatRemaining, formatWhen, localizeLabel, roundToMinute } from "./format";
import { messages, type Translate } from "./messages";
import { PROVIDER_ICONS } from "./provider-icons";
import {
  providerKind,
  barColor,
  budgetColor,
  windowBudget,
  remainingPct,
  useHiddenWindows,
  useNow,
  useUsage,
  type ProviderUsage,
  type UsageWindow,
} from "./usage-data";

// 进度条格子按实际宽度排：每格 3px 宽、间隔 2px，窄了也保持细密
const SEGMENT_WIDTH = 3;
const SEGMENT_GAP = 2;

// daemon 给的名字形如 "Claude (someone@example.com)"，拆成名字和账户，账户单独淡显
function splitDisplayName(displayName: string): { name: string; account: string | null } {
  const match = displayName.match(/^(.+?) \((.+)\)$/);
  return match ? { name: match[1], account: match[2] } : { name: displayName, account: null };
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  return {
    root: { padding: compact ? 14 : 10, gap: 10, minWidth: 240, maxWidth: 290 },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flex: 1 },
    button: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    buttonText: { color: theme.colors.foreground, fontSize: 11 },
    // 弹出层本身就是卡片，这里不再套边框，只用分隔线隔开账户
    card: { gap: 10 },
    divider: { height: 1, backgroundColor: theme.colors.border },
    provider: { gap: 9 },
    providerHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    providerName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    account: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
    plan: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 999,
      backgroundColor: theme.colors.surface2,
    },
    planText: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "600" as const,
      letterSpacing: 0.3,
    },
    window: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    windowBody: { flex: 1, gap: 4 },
    windowTop: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
    windowLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
    pctLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
    pct: { color: theme.colors.foreground, fontSize: 12, fontWeight: "700" as const },
    bar: { flexDirection: "row" as const, justifyContent: "space-between" as const, height: 12 },
    segment: { width: SEGMENT_WIDTH, borderRadius: SEGMENT_WIDTH / 2 },
    resetRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    when: { color: theme.colors.foregroundMuted, fontSize: 11 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
    // 单独一行，跟上面刷新时间的文字对齐（图标 11 + 间距 4）
    budget: { paddingLeft: 15, fontSize: 11, fontWeight: "600" as const },
    eye: { padding: 2 },
  };
}

type Styles = ReturnType<typeof makeStyles>;

// 分段进度条：亮色格子占比 = 剩余百分比，其余格子同色淡显
function SegmentBar({ pct, color, styles }: { pct: number; color: string; styles: Styles }) {
  const [width, setWidth] = useState(0);
  const count = Math.max(10, Math.floor((width + SEGMENT_GAP) / (SEGMENT_WIDTH + SEGMENT_GAP)));
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * count);
  return (
    <View style={styles.bar} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {width > 0
        ? Array.from({ length: count }, (_, index) => (
            <View
              key={index}
              style={[styles.segment, { backgroundColor: color, opacity: index < filled ? 1 : 0.15 }]}
            />
          ))
        : null}
    </View>
  );
}

function WindowRow({
  limit,
  hidden,
  onToggle,
  canToggle,
  now,
  theme,
  styles,
}: {
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
  const budget = windowBudget(limit, now);
  return (
    <View style={styles.window}>
      <View style={styles.windowBody}>
        <View style={styles.windowTop}>
          <Text style={styles.windowLabel}>{localizeLabel(limit.id, limit.label, t)}</Text>
          {left != null ? (
            <Text style={styles.pctLabel}>
              {t("remainingLabel")}
              <Text style={styles.pct}>{` ${Math.round(left)}%`}</Text>
            </Text>
          ) : null}
        </View>
        {left != null ? <SegmentBar pct={left} color={barColor(left)} styles={styles} /> : null}
        <View style={styles.resetRow}>
          <Icon name="History" size={11} color={theme.colors.foregroundMuted} />
          {resetsAt ? (
            <Text style={styles.muted} numberOfLines={1}>
              <Text style={styles.when}>{t("resetsAt", { when: formatWhen(resetsAt, now, locale, t) })}</Text>
              {` · ${formatRemaining(resetsAt, now, t)}`}
            </Text>
          ) : (
            <Text style={styles.muted}>{t("noReset")}</Text>
          )}
        </View>
        {budget ? (
          <Text style={[styles.budget, { color: budgetColor(budget.level) }]}>
            {t(budget.unit === "day" ? "perDay" : "perHour", { pct: Math.round(budget.perUnitPct) })}
          </Text>
        ) : null}
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
            size={15}
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
  const { name, account } = splitDisplayName(provider.displayName);
  return (
    <View style={styles.provider}>
      <View style={styles.providerHeader}>
        {svg ? <Icon icon={{ svg }} size={16} color={theme.colors.foreground} /> : null}
        <Text style={styles.providerName}>{name}</Text>
        {provider.planLabel ? (
          <View style={styles.plan}>
            <Text style={styles.planText}>{provider.planLabel.toUpperCase()}</Text>
          </View>
        ) : null}
        {account ? (
          <Text style={styles.account} numberOfLines={1}>
            {account}
          </Text>
        ) : null}
      </View>
      {provider.status !== "available" ? (
        <Text style={styles.muted}>{provider.error ?? t("unavailable")}</Text>
      ) : (
        provider.windows.map((limit) => (
          <WindowRow
            key={limit.id}
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
    body = (
      <Text style={[styles.muted, { color: theme.colors.statusDanger }]}>
        {t("error", { message: state.message })}
      </Text>
    );
  } else if (state.providers.length === 0) {
    body = <Text style={styles.muted}>{t("empty")}</Text>;
  } else {
    body = (
      <View style={styles.card}>
        {state.providers.map((provider, index) => (
          <Fragment key={provider.providerId}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <ProviderSection
              provider={provider}
              now={now}
              theme={theme}
              styles={styles}
              t={t}
              sidebar={sidebar}
            />
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
