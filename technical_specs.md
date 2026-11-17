# osu! Team Statistics — Specification v0.1

Status: Draft for review. Not an implementation prompt.

## 1. Architecture

1.1 — Monorepo using Bun workspaces, Elysia and TypeScript (`strict: true`). Three components: browser frontend, Elysia web backend, and independent data collector.

1.2 — Browser frontend: renders interfaces, manages selectors, displays Chart.js graphs and receives live updates. Built with Bun's bundler; vanilla TypeScript, CSS and HTML without an additional frontend framework.

1.3 — Web backend: Elysia application serving the website, JSON endpoints and live-update events. Reads SQLite and calculates requested statistics, historical comparisons and player rankings.

1.4 — Collector: independent Bun process responsible for osu! OAuth2, API request scheduling, team synchronization, score ingestion, hourly snapshots and database writes.

1.5 — Shared packages: `database` for SQLite schema/migrations/queries, `contracts` for game modes and metric definitions, and `config` for validated TOML loading. One database writer (collector), concurrent readers through SQLite WAL.

1.6 — Deployment: one SQLite file shared by both server processes on the same machine, created beside the configuration in the data directory (`data/` by default: `data/config.toml` + `data/team.sqlite`). Web backend port `3000`. No external database server or message broker.

1.7 — Configuration is a single TOML file read by both server processes from a fixed relative location; there are no environment variables and no CLI flags. The data directory is the state anchor: locally `./data/`, or any directory provided by the deployment (e.g. bind-mounted into a NixOS container).

## 2. Configuration

2.1 — Required TOML value: `team_id` (positive integer). The configured team determines its identity, logo, roster and default game mode automatically. No team-specific values are hardcoded.

2.2 — Required TOML credentials: `client_id` and `client_secret` (osu! OAuth application values). Credentials live in the configuration file, never in environment variables; the file is kept out of version control.

2.3 — `rate_divider`: optional integer ≥ 1, default `2`. The request budget is 60/divider requests per minute; every osu! API request uses the same scheduler.

2.4 — The score-feed base interval is a fixed rule, not a parameter: 5 seconds. Effective regular polling interval = `5 × rate_divider`, therefore 10 seconds by default.

2.5 — Hourly profile collection interval: exactly 1 hour, fixed in code. The divider affects request execution speed, not the hourly schedule.

2.6 — Both server processes read the same validated configuration from `data/config.toml`; the SQLite file is created in the same directory. The frontend receives only public team information through the web backend. Missing required values prevent startup with an explicit error naming the key and the file. The web backend port is fixed at 3000; there is no configurable port or database path.

## 3. Collector — osu! Data Acquisition

3.1 — Team synchronization: request `/api/v2/teams/{team_id}` at collector startup and each hourly collection. The roster contains both the leader and members; membership changes become effective upon successful synchronization.

3.2 — Score feed: poll `/api/v2/scores` without a ruleset filter, covering all four modes. Process its ordered batches of up to 1,000 passed scores, retaining scores whose `user_id` belongs to the current team.

3.3 — Score cursor: first execution initializes from the latest available feed batch. Subsequent requests provide the persisted `cursor_string`. After successful processing, persist matching scores and the returned cursor atomically; unchanged cursor means the feed is caught up.

3.4 — Feed catch-up: continue requesting subsequent batches when new scores remain available, including full batches of 1,000. Schedule these requests through the same request queue rather than creating parallel API connections. A stopped collector resumes using its persisted cursor.

3.5 — API scheduler: one sequential request queue, minimum spacing `rate_divider × 1 second`, with a rolling 60-second request limit. Score-feed requests receive priority when behind; hourly profile requests run between feed requests without starving either workload.

3.6 — Error handling follows the osu! wiki good practices: transient failures (network, 5xx, 429) retry with exponential backoff, honouring `Retry-After`, within the 60 req/min budget; other 4xx failures are permanent and logged with the endpoint and collection context.

3.7 — Hourly profiles: at each UTC hour, synchronize membership, then retrieve all current members using `/api/v2/users`, split into chunks of at most 50 IDs. Each returned user's available statistics for all four game modes are processed.

3.8 — Hourly collection consistency: create one logical collection ID representing its UTC hour. Each member's real gathering timestamp is recorded separately for diagnostics; it never determines the historical point's position.

3.9 — Atomic hourly publishing: stage all retrieved members and modes before writing the completed statistical collection in one transaction. If required requests fail after retries, record a failed collection attempt and publish no partial snapshot.

3.10 — Large teams: chunk requests automatically, respect the shared API budget, and avoid overlapping hourly collections. A collection exceeding the next hour is completed or failed before another begins; missed logical hours are recorded.

3.11 — Beatmap enrichment: store information supplied with matching scores; fetch missing beatmap metadata through lower-priority queued requests and cache it by beatmap ID to avoid repeated lookups.

3.12 — Membership removal: players no longer in the team cease receiving new profile snapshots and disappear from public rankings and recent-play results. Existing historical records remain stored.

## 4. SQLite — Stored Data and Calculations

4.1 — `team`: configured osu! ID, name, short name, flag/logo URL, default game mode and synchronization timestamp.

4.2 — `members`: osu! user ID, username, avatar URL, country, membership status, first/last observed timestamps. User ID is the stable identifier; usernames may change.

4.3 — `collections`: unique collection ID, logical UTC hour, attempt start/finish timestamps, roster size, result status and error details. A logical hour can have only one published successful collection.

4.4 — `profile_snapshots`: collection ID + user ID + game mode, with actual `gathered_at` for diagnostics and the following normalized metric groups:

- Performance: PP, global rank, country rank, accuracy and maximum combo.
- Scores: ranked score, total score and total hits.
- Activity: play count, cumulative play time and replay views.
- Progression: level and level progress.
- Grades: counts of SS, SSH, S, SH and A.
- Available hit-statistic counts: 300, 100, 50 and misses.

4.5 — Numeric storage: use SQLite INTEGER for counters and scores, REAL for PP and accuracy, and NULL for unavailable values. Preserve accuracy internally as a fraction (0–1) and format it as a percentage only for presentation. Handle integers beyond JavaScript's safe integer range without precision loss.

4.6 — `scores`: unique osu! score ID, player ID, beatmap ID, game mode, completion timestamp, PP (nullable), accuracy, score values, grade, combo, mods and hit-statistic breakdown. Preserve distinctions between stable/lazer scoring variants.

4.7 — `beatmaps`: beatmap ID, beatmapset ID, title, artist, difficulty name, star rating, length, status and available artwork reference. Store only metadata necessary for displaying and contextualizing captured plays.

4.8 — `collector_state`: durable score-feed cursor, last successful ingestion time and synchronization state. Commit cursor updates together with the scores they cover.

4.9 — Derived data: calculate player ordering, metric differences, percentage changes and time-series responses using stored observations; do not duplicate these as permanent snapshot columns. Recent passed-score counts are calculated from `scores`, not confused with osu!'s profile `play_count`.

4.10 — Data integrity: foreign keys enabled, uniqueness enforced for score IDs and member/mode/collection combinations, indexes on `(user_id, mode, collection_id)` and `(mode, ended_at)`. Migrations are versioned.

## 5. Website — Functionality

5.1 — Exactly two pages: `Leaderboards` (default) and `Live`. Shared header with team logo/name on the left, navigation centered, and osu!, taiko, catch and mania selectors on the right.

5.2 — Game-mode selector applies to both pages. Internal mode identifiers are `osu`, `taiko`, `fruits` and `mania`; user-visible names are human-readable.

### Leaderboards

5.3 — Above the content islands, a statistic selector chooses the metric. Initial visible metrics: PP (default), ranked score, total score, play count, accuracy, play time and total hits. Additional metrics are registered through shared metric definitions.

5.4 — First island: Chart.js line graph showing every current member's selected metric for the selected mode. A timeline selector above the graph offers `24 hours` (default) and `7 days`.

5.5 — Hourly graph: 23 preceding hourly observations followed by the current point. Daily graph: six preceding days at the same UTC hour followed by the current point.

5.6 — **Proposed current-point definition:** latest successfully published hourly collection. No additional player-profile polling mechanism. Display its actual logical timestamp so users know how recent the values are.

5.7 — Missing observations remain gaps, not interpolated values. On initial installation, the graph progressively fills as hourly collections accumulate.

5.8 — Second island: one ranked entry per current team member, displaying username/avatar, current selected metric, change over 23 hours and change over six days. Both comparisons use the same historical points as the graph.

5.9 — Ranking defaults to descending numerical value; rank-based metrics use ascending ranking. Equal values share the same position. Missing values sort last. Rank improvements are displayed with the correct positive/negative meaning.

### Live

5.10 — First island: 10 newest captured completed plays for the selected mode, sorted by completion timestamp. Display player, beatmap/difficulty, grade, mods, PP when available, accuracy, score and relative/absolute completion time.

5.11 — Second island: extended team leaderboard built from collected profile statistics. Default sorting is PP, with additional sortable statistics including ranked score, total score, accuracy, play count, play time, total hits, global rank and grade counts.

5.12 — Live leaderboard represents the newest complete profile collection; recent plays may arrive between hourly profile collections. The two data sources must display their respective update timestamps.

## 6. Website — Data Delivery and Interaction

6.1 — Elysia renders the initial page with team identity, navigation and available statistics. The browser bundle initializes Chart.js and attaches interactions without a full client-side application framework.

6.2 — Data endpoints: `GET /api/team`, `GET /api/leaderboards?mode=&metric=&period=`, `GET /api/live/plays?mode=&limit=10`, and `GET /api/live/leaderboard?mode=&sort=`.

6.3 — Leaderboard response contains the selected metric's definition/unit, logical collection timestamp, time-axis labels, one series per player, and ranked player entries including their historical differences. All calculations occur in the web backend.

6.4 — Selector changes use `fetch` to retrieve the appropriate JSON and update only affected sections. Chart.js updates existing datasets using `chart.update()`. Selected mode, metric and period are represented in the URL query for directly shareable views; no browser persistence is required.

6.5 — Proposed live delivery: `GET /api/events` using Server-Sent Events. The web backend checks a database change sequence every 2 seconds and notifies connected browsers when scores or a completed profile collection become available. Clients then request updated data.

6.6 — During network errors, keep the last successfully rendered data and show its timestamp and an unobtrusive connection indicator. Reconnect SSE automatically; never display stale values as freshly collected.

## 7. Visual Design and Accessibility

7.1 — Minimal, typography-led design with no filled header background, no island background panels, and no enclosing card borders. Use thin separators at island headings and subtle borders around relevant data points or controls.

7.2 — Layout: header with three aligned areas; Leaderboards metric selector above its two vertically stacked islands; graph timeline selector at the top of the first island; footer with GitHub link and appropriate unofficial-project/attribution information.

7.3 — Chart.js lines represent individual players. Assign colors in OKLCH using evenly distributed hues across the roster, with consistent chroma/lightness within each theme. Adjust where required for contrast; preserve player-color association across metric and timeline changes.

7.4 — Chart styling: thin lines, visible data points, restrained grid lines, readable axes and value tooltips. Avoid filled area charts. On crowded graphs, provide player highlighting and a readable player legend without excluding members by default.

7.5 — CSS design tokens: one compact shared set for background, foreground, muted text, separator, focus, positive/negative indicators and spacing. Prefer spacing steps of 4, 8, 12, 16, 24 and 32 pixels; reuse values rather than introducing per-component variables.

7.6 — System theme: `prefers-color-scheme` handled entirely in initial CSS, loaded before the first rendered content. Define both palettes in CSS so no wrong-theme flash occurs. No theme selector.

7.7 — WCAG 2.2 AA target: required color contrast, semantic landmarks, labeled controls, visible focus, usable keyboard navigation and non-color-only graph identification. Provide accessible textual time-series data alongside the canvas graph.

7.8 — Respect reduced-motion preferences; disable nonessential graph animations accordingly. Interface responds to narrow screens without hiding metrics or truncating essential statistics.

7.9 — No cookies, local storage, accounts, user settings, advertising trackers or client-side statistical business logic. Client JavaScript handles rendering, selections and live communication.

## 8. Implementation and Verification

8.1 — Root commands: `bun run dev`, `bun run build`, `bun run start`, `bun run test` and `bun run typecheck`. Development starts collector and web backend together; production runs them as separate processes.

8.2 — Use Bun's test runner for metric calculations, hourly time-axis selection, null handling, ranking rules, configuration validation, SQLite transactions and collector scheduling.

8.3 — Collection fixtures must cover 1, 50, 51 and 5,000 members; score batches of 0, partial size and 1,000; repeated scores; cursor recovery; authentication renewal; rate limiting; and incomplete hourly collection rollback.

8.4 — Browser tests cover both pages, game-mode changes, metric/period selection, live updates, empty startup, missing history, system themes, narrow layouts and WCAG checks.

8.5 — Collector logs collection IDs, logical hours, request/retry counts, score cursor progress, batch duration and failures. Logs never expose OAuth credentials.

8.6 — First startup: validate configuration, create/migrate SQLite, fetch the configured team, initialize the score feed, and perform the first profile collection. Historical graphs start with available real observations; no artificial backfill.

## 9. Decisions to Confirm During Review

9.1 — The latest successful hourly profile collection is the graph's "current" value; there is no separate current-profile retrieval process.

9.2 — Score-feed base interval is 5 seconds multiplied by the divider, with a 10-second effective default.

9.3 — SSE is used for live browser updates; the browser refreshes only the affected content.

9.4 — Vanilla TypeScript and Chart.js are used for the frontend, without React or a comparable framework.

9.5 — SQLite history and collected team scores are retained indefinitely by default; no automatic pruning in version one.

