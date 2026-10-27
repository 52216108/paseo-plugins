import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sidebarPrefs } from "./shared/settings";

// 服务端只负责保存侧边栏显示哪些窗口（弹出层的眼睛开关）
export default function contribute(server: PluginServerContext) {
  server.registerSettings(sidebarPrefs);
  return () => {};
}
