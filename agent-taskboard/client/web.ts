import { createElement, type ReactElement } from "react";
import { Platform } from "react-native";

// 只用到下面这几个浏览器全局，tsconfig 不开 DOM lib，按需声明
declare const window: { location: { pathname: string } };
declare function atob(data: string): string;
declare class TextDecoder {
  decode(input: Uint8Array): string;
}

// 只有桌面端（web 渲染）能嵌入页面；原生端返回 null，由调用方给出说明
export const canEmbed = Platform.OS === "web";

export function EmbeddedPage({ url, title }: { url: string; title: string }): ReactElement | null {
  if (!canEmbed) return null;
  // 父容器需 position: relative；iframe 用 flex 撑高在 react-native-web 下会塌成 0 高，改为绝对定位铺满
  return createElement("iframe", {
    src: url,
    title,
    style: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" },
  });
}

// Paseo 路由里含特殊字符的 ID 编码为 `b64_` + base64url(utf8)，其余原样
function decodeRouteId(segment: string): string {
  let raw = segment;
  try {
    raw = decodeURIComponent(segment);
  } catch {
    // 保留原文
  }
  if (!raw.startsWith("b64_")) return raw;
  try {
    const b64 = raw.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")), (c) =>
      c.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return raw;
  }
}

// 当前桌面端页面停在哪个工作区 / agent（/h/<主机>/workspace/<id>、/h/<主机>/agent/<id>）；原生端或其他页面返回 null
export function currentRoute(): { kind: "workspace" | "agent"; id: string } | null {
  if (!canEmbed) return null;
  const match = window.location.pathname.match(/^\/h\/[^/]+\/(workspace|agent)\/([^/]+)\/?$/);
  if (!match) return null;
  return { kind: match[1] as "workspace" | "agent", id: decodeRouteId(match[2]) };
}
