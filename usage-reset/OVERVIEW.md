Shows the exact time each usage limit resets. Paseo's built-in usage view tells you a limit resets "in 2 days"; this plugin adds one row per account, marked by its icon, to the bottom of the sidebar. Each row shows how much of the 5-hour, weekly, and per-model weekly limits is left (for example "93% 5h  17% wk  45% Fable" for Claude, "50% wk" for Codex), colored when you are using it up fast. Clicking a row opens a list with the clock time of each reset, for example "Tue 10/27 21:00, in 2d 7h".

## What it shows

For every provider account the daemon reports usage for (Claude, Codex, and others that have limit windows), each window is listed with:

- its name (5-hour, Weekly, Weekly per model, Monthly) and the plan,
- the percentage left with a segmented bar: blue with 30% or more left, orange from 10% to 30%, red under 10%,
- the reset time in your local time zone, rounded to the minute, plus the time left,
- the daily allowance (hourly for the 5-hour limit): what is left divided by the days until reset. Spread evenly, a weekly limit allows about 14% a day, a 5-hour limit 20% an hour, a monthly limit about 3.3% a day. It is green at 85% of that pace or more, orange below 85%, red below half. It is hidden when the reset is less than a day away (an hour for the 5-hour limit).

Sidebar percentages use the normal text color and turn orange or red when the daily allowance does. An eye toggle beside each window in the list hides it from the sidebar; an account whose windows are all hidden leaves the sidebar. Today and tomorrow are written as words. Labels follow the app language (English, Simplified Chinese).

Window lengths are inferred from the window type (5 hours, 7 days, 30 days); windows of unknown length show no daily allowance.

## Freshness

The sidebar rows and the list share one copy of the data, read every 5 minutes and again when the list opens. Paseo's daemon caches usage for 5 minutes, so numbers can trail the provider by up to about 10 minutes. The Refresh button re-reads the daemon's copy; it cannot force the daemon to fetch from the provider before its cache expires.

## What it reads

The plugin only reads the usage report Paseo already fetches for its own usage view, through the Paseo SDK on the selected host, so it shows the accounts logged in on that host's daemon. It makes no network requests of its own. Its daemon code only saves which windows are hidden from the sidebar, in that host's Paseo plugin settings; usage data is not stored. Requires Paseo 0.13 or later.
