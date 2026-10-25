# paseo-plugins

**简体中文** | [English](README.en.md)

自己写的 [Paseo](https://paseo.sh) 插件，每个子目录一个插件。

| 插件 | 作用 | 安装 |
|---|---|---|
| [`turn-speed`](turn-speed/OVERVIEW.zh-CN.md) | Claude Code / Codex 每轮结束后在对话末尾显示生成速度（tok/s、输出 token、生成耗时、请求次数）。数据取自 daemon 机器上 CLI 自己的会话日志，在本机解析，只保留时间戳和 token 数 | 已上架插件市场：`paseo plugin add 52216108/turn-speed` |
| [`usage-reset`](usage-reset/OVERVIEW.zh-CN.md) | 侧边栏底部加一行「限额」，直接显示 Claude / Codex 各账户 5 小时、周限额还剩多少（按余量绿、黄、红上色），点开列出具体刷新时刻（如「周二 10/27 21:00 刷新 · 还有 2 天 8 小时」）。只读 Paseo 已拉取的用量报告 | 暂未上架，装本地目录（见下） |
| [`next-input`](next-input/OVERVIEW.zh-CN.md) | 每轮结束后用现有 Claude 接入的 Haiku 根据最近对话生成一条输入建议；点击可编辑、复制或手动发送 | 暂未上架，装本地目录（见下） |

插件按 daemon 安装，每台机器各装一次；装之前先在 Settings → Plugins 打开 Enable plugins。

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
