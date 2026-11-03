import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

interface WorkspaceDirs {
  id: string;
  workspaceDirectory: string;
  projectRootPath: string;
}

// 给每个工作区的顶栏加一个「看板」按钮，点开直接定位到该工作区所在项目的看板
export function contributeWorkspaceButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  let disposed = false;
  let release: (() => void) | null = null;

  const register = (workspace: WorkspaceDirs) => {
    if (disposed) return;
    buttons.get(workspace.id)?.remove();
    const params = { dir: workspace.workspaceDirectory, root: workspace.projectRootPath };
    buttons.set(
      workspace.id,
      client.addHeaderButton({
        id: "board",
        workspaceId: workspace.id,
        button: {
          title: "打开本项目看板",
          icon: "SquareKanban",
          behavior: {
            kind: "action",
            onPress() {
              client.openScreen({ screenId: "board", params });
            },
          },
        },
      }),
    );
  };
  const removeAll = () => {
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };

  // 订阅先给全量快照，之后推增量；断线重连会再给一份新快照
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (disposed) return void subscription.release();
      const unsubscribe = subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const workspace of entries) register(workspace);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.workspace);
          buttons.get(update.id)?.remove();
          buttons.delete(update.id);
        },
      });
      release = () => {
        unsubscribe();
        void subscription.release();
      };
      return undefined;
    })
    .catch((error) => {
      if (!disposed) console.error("看板插件：订阅工作区列表失败", error);
    });

  return () => {
    disposed = true;
    release?.();
    removeAll();
  };
}
