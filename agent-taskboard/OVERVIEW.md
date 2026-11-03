Adds a Board entry to the Paseo sidebar that opens the local agent-taskboard board (default `http://127.0.0.1:7788`).

Each time it opens, the board's own left navigation starts collapsed to leave more room for content. A button at the top expands it; this does not change the sidebar preference in a regular browser.

Start the agent-taskboard service on the daemon host first. The plugin's server checks whether the service is reachable and shows a notice with a retry button when it is not. If the board requires `BOARD_TOKEN`, the plugin reads it the same way the board CLI does: the environment variable first, then `~/.project-board/token`.

The board page is shown on desktop only. A phone cannot reach the computer's local address, so it shows an explanation instead.
