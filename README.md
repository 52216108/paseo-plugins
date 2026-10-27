# paseo-plugins

**简体中文** | [English](README.en.md)

自己写的 [Paseo](https://paseo.sh) 插件，每个子目录一个插件。

| 插件 | 作用 | 安装 |
|---|---|---|
| [`turn-speed`](turn-speed/OVERVIEW.zh-CN.md) | Claude Code / Codex 每轮结束后在对话末尾显示生成速度（tok/s、输出 token、生成耗时、请求次数）。数据取自 daemon 机器上 CLI 自己的会话日志，在本机解析，只保留时间戳和 token 数 | 已上架插件市场：`paseo plugin add 52216108/turn-speed` |
| [`usage-reset`](usage-reset/OVERVIEW.zh-CN.md) | 侧边栏底部每个账户一行，直接显示 Claude / Codex 各账户 5 小时、周限额还剩多少（用量偏快时变色提醒，列表里有分段进度条和日均可用），点开列出具体刷新时刻（如「周二 10/27 21:00 刷新 · 还有 2 天 8 小时」）。只读 Paseo 已拉取的用量报告 | 已上架插件市场：`paseo plugin add 52216108/usage-reset` |
| [`next-input`](next-input/OVERVIEW.zh-CN.md) | 打开会话时用现有 Claude 接入及可选模型按需生成一条下一句建议，显示在回复末尾；点纸飞机直接发送，点文字可编辑 | 已上架插件市场：`paseo plugin add 52216108/next-input` |

插件按 daemon 安装，每台机器各装一次；装之前先在 Settings → Plugins 打开 Enable plugins。

2026-10-25 起 turn-speed 的来源从 paseo-mesh 仓库搬到本仓库。之前装过的机器运行 `paseo plugin update` 会提示来源已变更，需要重装一次：`paseo plugin remove turn-speed && paseo plugin add 52216108/turn-speed`。

## 从本地目录安装 / 改代码

```bash
git clone https://github.com/52216108/paseo-plugins.git
cd paseo-plugins/<插件目录>
npm install
paseo plugin install "$PWD"
```

改完源码后先 `npm run typecheck`，再 `paseo plugin reload <插件 id>`。

跨会话、跨机器协作的 skill 在另一个仓库：[paseo-mesh](https://github.com/52216108/paseo-mesh)。

## License

MIT
