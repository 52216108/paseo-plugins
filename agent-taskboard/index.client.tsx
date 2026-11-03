import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BoardScreen } from "./client/board-screen";
import { currentRoute } from "./client/web";
import { contributeWorkspaceButtons } from "./client/workspace-buttons";

// 点击时若正停在某个工作区（或其中的 agent）页面，打开该工作区所在项目的看板；否则打开项目概览
function boardSidebarItem(client: PluginClientContext) {
  const findWorkspace = async () => {
    const route = currentRoute();
    if (!route) return null;
    let workspaceId = route.id;
    if (route.kind === "agent") {
      const agent = client.paseo.agents.ref(route.id);
      await agent.refresh();
      const id = agent.current()?.workspaceId;
      if (!id) return null;
      workspaceId = id;
    }
    return client.paseo.workspaces.ref(workspaceId).refresh();
  };
  return function BoardSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
    const onPress = () => {
      findWorkspace()
        .catch(() => null)
        .then((workspace) => {
          if (!workspace) return openScreen({ screenId: "board" });
          openScreen({
            screenId: "board",
            params: { dir: workspace.workspaceDirectory, root: workspace.projectRootPath },
          });
        });
    };
    return <SidebarRow icon="SquareKanban" active={currentScreen?.screenId === "board"} onPress={onPress} />;
  };
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "board", title: "看板", Component: BoardScreen });
  client.addSidebarHeaderItem({ id: "board", title: "看板", Component: boardSidebarItem(client) });
  client.addCommandCenterItem({
    id: "open-project-board",
    title: "打开本项目看板",
    icon: "SquareKanban",
    context: "workspace",
    onSelect({ workspace, openScreen }) {
      openScreen({ screenId: "board", params: { dir: workspace.directory, root: workspace.projectRootPath } });
    },
  });
  const removeButtons = contributeWorkspaceButtons(client);
  return () => removeButtons();
}
