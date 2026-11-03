import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 本机 agent-taskboard 服务地址（与看板默认监听地址一致）
export const BOARD_URL = "http://127.0.0.1:7788";

// 探测看板服务并按目录找出对应的看板项目。
// paths 按优先级排列（工作区目录在前、项目根目录在后），逐个按「路径最长匹配」找，先命中者胜；
// 为空时只做探测。reachable=false 时 error 给出原因；project 为看板项目 name，找不到为 null。
export const boardLocate = defineRpc({
  name: "board.locate",
  input: z.object({ paths: z.array(z.string()) }),
  output: z.object({
    url: z.string(),
    reachable: z.boolean(),
    error: z.string().optional(),
    project: z.string().nullable(),
  }),
});

// 看板前端的项目页路径：子仓名形如 `外壳/子仓`，斜杠保留、每段单独转义（与看板 projectHref 一致）
export function projectPath(name: string): string {
  return `/p/${name.split("/").map(encodeURIComponent).join("/")}`;
}
