import type { PluginServerContext } from "@getpaseo/plugin/server";
import { locateBoard } from "./server/board";
import { boardLocate } from "./shared/board";

export default function contribute(server: PluginServerContext) {
  server.handle(boardLocate, ({ paths }) => locateBoard(paths));
  return () => {};
}
