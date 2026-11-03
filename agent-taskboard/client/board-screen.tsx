import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { boardLocate, projectPath } from "../shared/board";
import { EmbeddedPage, canEmbed } from "./web";

// 页面参数：dir = 工作区目录，root = 项目根目录；都没有时打开看板首页（项目概览）
export function BoardScreen({ theme, layout, params }: PluginScreenProps) {
  const locate = useRpc(boardLocate);
  const paths = [params.dir, params.root].filter((p): p is string => !!p);
  const status = useQuery({
    queryKey: ["board-locate", ...paths],
    queryFn: () => locate({ paths }),
    enabled: canEmbed,
    retry: false,
  });
  const styles = useMemo(
    () => ({
      screen: { flex: 1, position: "relative" as const, backgroundColor: theme.colors.surface0 },
      notice: { flex: 1, padding: layout.compact ? 16 : 24, gap: 12, backgroundColor: theme.colors.surface0 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 17 : 19, fontWeight: "600" as const },
      body: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
      button: {
        alignSelf: "flex-start" as const,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14 },
    }),
    [theme, layout.compact],
  );

  if (!canEmbed) {
    return (
      <View style={styles.notice}>
        <Text style={styles.title}>请在电脑端打开看板</Text>
        <Text style={styles.body}>看板服务运行在电脑本机，手机端无法直接访问。</Text>
      </View>
    );
  }
  if (status.isPending) return <Loading />;
  if (status.isError || !status.data.reachable) {
    const reason = status.isError
      ? status.error instanceof Error
        ? status.error.message
        : String(status.error)
      : status.data.error;
    return (
      <View style={styles.notice}>
        <Text style={styles.title}>看板服务没有响应</Text>
        <Text style={styles.body}>
          无法连接 {status.data?.url ?? "看板服务"}，请确认 agent-taskboard 服务已启动。
          {reason ? `\n原因：${reason}` : ""}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重新连接看板服务"
          onPress={() => void status.refetch()}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{status.isFetching ? "连接中" : "重试"}</Text>
        </Pressable>
      </View>
    );
  }
  // 带了目录却没匹配到看板项目时退回项目概览，不报错
  const { url, project } = status.data;
  return (
    <View style={styles.screen}>
      <EmbeddedPage url={`${project ? url + projectPath(project) : url}?sidebar=collapsed`} title="看板" />
    </View>
  );
}
