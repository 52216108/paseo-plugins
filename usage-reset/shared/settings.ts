import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// 侧边栏不显示的限额窗口，键为 `${providerId}/${windowId}`；默认全部显示
export const sidebarPrefs = defineSettings({
  id: "sidebar",
  scope: "host",
  version: 1,
  schema: z.object({ hidden: z.array(z.string()).default([]) }),
});

export function windowKey(providerId: string, windowId: string): string {
  return `${providerId}/${windowId}`;
}
