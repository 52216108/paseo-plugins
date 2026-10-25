Shows the exact time each usage limit resets. Paseo's built-in usage view tells you a limit resets "in 2 days"; this plugin adds one row per account, marked by its icon, to the bottom of the sidebar. Each row shows how much of the 5-hour, weekly, and per-model weekly limits is left (for example "97% 5h  17% wk  46% Fable" for Claude, "51% wk" for Codex), colored green, yellow, or red by headroom. Clicking it opens a list with the clock time of each reset, for example "Tue 10/27 21:00, in 2d 8h".

## What it shows

For every provider account the daemon reports usage for (Claude, Codex, and others that have limit windows), each window is listed with:

- its name (5-hour, Weekly, Weekly per model, Monthly),
- the percentage left, green when there is plenty, yellow near the limit, red when nearly used up,
- the reset time in your local time zone, rounded to the minute, plus the time left.

Today and tomorrow are written as words. The list refreshes every 5 minutes while open and has a Refresh button. Labels follow the app language (English, Simplified Chinese).

## What it reads

The plugin only reads the usage report Paseo already fetches for its own usage view, through the Paseo SDK on the selected host. It runs entirely in the app, has no daemon code, makes no network requests of its own, and stores nothing. Requires Paseo 0.13 or later.
