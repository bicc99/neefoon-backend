**[src/db/database.ts](vscode-webview://010k0b2nockims9h2mr28l145d6u912bdgt00rsovfrh6bv5htee/src/db/database.ts)** — new file

* Opens/creates `data/neefoon.db` with WAL mode for better performance
* Two tables: `station_aqi_readings` (hourly, 35-day retention, pruned on startup) and `station_aqi_daily` (one row per station per day, kept forever)
* `insertReading()` — inserts a point, then automatically upserts the daily average with `color_key` computed via SQL `CASE`
* `getLast24()` — returns last 24 readings for the 24h trend chart
* `getDailyForYear()` — returns all daily averages for a given year, used by the calendar UI

**[src/routes/aqi.ts](vscode-webview://010k0b2nockims9h2mr28l145d6u912bdgt00rsovfrh6bv5htee/src/routes/aqi.ts)** — two changes

* `pushHistory()` now persists each reading to DB and reloads last 24 from DB into memory — so after a server restart, history is immediately available to every user
* New route `GET /api/aqi/stations/:stationID/daily?year=2026` returns `{ stationID, year, days: [{ date, avgAqi, colorKey, minAqi, maxAqi, sampleCount }] }` for the calendar grid

**[.gitignore](vscode-webview://010k0b2nockims9h2mr28l145d6u912bdgt00rsovfrh6bv5htee/.gitignore)** — new file, excludes the SQLite files (including WAL `-shm`/`-wal` sidecar files) from version control
