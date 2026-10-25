# paseo-plugins

[简体中文](README.md) | **English**

[Paseo](https://paseo.sh) plugins, one per directory.

| Plugin | What it does | Install |
|---|---|---|
| [`turn-speed`](turn-speed/OVERVIEW.md) | After each Claude Code or Codex turn, shows generation speed at the end of the turn (tok/s, output tokens, generation time, request count). Parses the CLI's own session logs locally on the daemon machine and keeps only timestamps and token counts | In the plugin registry: `paseo plugin add 52216108/turn-speed` |
| [`usage-reset`](usage-reset/OVERVIEW.md) | Adds a **Limits** row to the bottom of the sidebar showing how much of each Claude / Codex 5-hour and weekly limit is left, colored by headroom; clicking it lists the exact reset time of each (for example "Tue 10/27 21:00, in 2d 8h"). Only reads the usage report Paseo already fetches | Not in the registry yet; install the local directory (below) |
| [`next-input`](next-input/OVERVIEW.md) | Predicts one editable next message on demand when a conversation is opened, using a selectable model through the existing Claude account. Displays the full suggestion inline. | Not listed yet; install the local directory below |

Plugins are installed per daemon, once on each machine; turn on Settings → Plugins → Enable plugins first.

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
