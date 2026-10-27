# paseo-plugins

[简体中文](README.md) | **English**

[Paseo](https://paseo.sh) plugins, one per directory.

| Plugin | What it does | Install |
|---|---|---|
| [`turn-speed`](turn-speed/OVERVIEW.md) | After each Claude Code or Codex turn, shows generation speed at the end of the turn (tok/s, output tokens, generation time, request count). Parses the CLI's own session logs locally on the daemon machine and keeps only timestamps and token counts | In the plugin registry: `paseo plugin add 52216108/turn-speed` |
| [`usage-reset`](usage-reset/OVERVIEW.md) | Adds one row per account to the bottom of the sidebar showing how much of each Claude / Codex 5-hour and weekly limit is left, colored when you are using it up fast; clicking it lists the exact reset time of each (for example "Tue 10/27 21:00, in 2d 8h"). Only reads the usage report Paseo already fetches | In the plugin registry: `paseo plugin add 52216108/usage-reset` |
| [`next-input`](next-input/OVERVIEW.md) | Predicts one editable next message on demand when a conversation is opened, using a selectable model through the existing Claude account. Shows it at the end of the reply; tap the paper plane to send it or the text to edit it. | In the plugin registry: `paseo plugin add 52216108/next-input` |

Plugins are installed per daemon, once on each machine; turn on Settings → Plugins → Enable plugins first.

Since 2026-10-25 turn-speed is published from this repository instead of paseo-mesh. Machines that installed it earlier get "source changed" from `paseo plugin update`; reinstall once: `paseo plugin remove turn-speed && paseo plugin add 52216108/turn-speed`.

## Install from a local directory / hack on it

```bash
git clone https://github.com/52216108/paseo-plugins.git
cd paseo-plugins/<plugin directory>
npm install
paseo plugin install "$PWD"
```

After editing, run `npm run typecheck`, then `paseo plugin reload <plugin id>`.

Skills for cross-session and cross-machine collaboration live in [paseo-mesh](https://github.com/52216108/paseo-mesh).

## License

MIT
