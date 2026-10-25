Shows the exact time each usage limit resets. Paseo's built-in usage view tells you a limit resets "in 2 days"; this plugin adds one row per account, marked by its icon, to the bottom of the sidebar. Each row shows how much of the 5-hour, weekly, and per-model weekly limits is left (for example "93% 5h  17% wk  45% Fable" for Claude, "50% wk" for Codex), colored by headroom. Clicking a row opens a list with the clock time of each reset, for example "Tue 10/27 21:00, in 2d 7h".

## What it shows

For every provider account the daemon reports usage for (Claude, Codex, and others that have limit windows), each window is listed with:

- its name (5-hour, Weekly, Weekly per model, Monthly),
- the percentage left: green while under 70% is used, yellow from 70% to 90%, red above 90%, using the levels the daemon reports,
- the reset time in your local time zone, rounded to the minute, plus the time left.

Today and tomorrow are written as words. Labels follow the app language (English, Simplified Chinese).

## Freshness

The sidebar rows and the list share one copy of the data, read every 5 minutes and again when the list opens. Paseo's daemon caches usage for 5 minutes, so numbers can trail the provider by up to about 10 minutes. The Refresh button re-reads the daemon's copy; it cannot force the daemon to fetch from the provider before its cache expires.

## What it reads

The plugin only reads the usage report Paseo already fetches for its own usage view, through the Paseo SDK on the selected host, so it shows the accounts logged in on that host's daemon. It runs entirely in the app, has no daemon code, makes no network requests of its own, and stores nothing. Requires Paseo 0.13 or later.
