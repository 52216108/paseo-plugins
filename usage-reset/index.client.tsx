import type { PluginClientContext } from "@getpaseo/plugin/client";
import { messages } from "./client/messages";
import { UsageResetSidebarItem } from "./client/usage-popover";

export default function contribute(client: PluginClientContext) {
  client.addSidebarFooterItem({
    id: "usage-reset",
    title: messages.message("title"),
    Component: UsageResetSidebarItem,
  });
  return () => {};
}
