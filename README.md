# super-simple-osu-team-dashboard

Unofficial statistics dashboard for an osu! **team**: per-member leaderboards
with hourly history and live recent plays, for all four game modes
(osu!, osu!taiko, osu!catch, osu!mania).

An independent **collector** polls the [osu!api v2](https://osu.ppy.sh/docs/index.html)
with OAuth2 client credentials into a local SQLite database (WAL), and an
**Elysia** web backend serves the site, JSON endpoints and Server-Sent Events.
Not affiliated with or endorsed by ppy Pty Ltd.

## Architecture

Monorepo with Bun workspaces, TypeScript (`strict: true`) and three components
(per `technical_specs.md`):

```
apps/
  collector/   osu! OAuth2, request scheduler, team sync, score feed,
               hourly profile snapshots, beatmap enrichment
  web/         Elysia web backend: pages, JSON API, SSE
  frontend/    vanilla TypeScript + Chart.js, built with Bun's bundler
packages/
  contracts/   game modes, metric and sort definitions, value helpers
  config/      validated TOML loading
  database/    SQLite schema, migrations, queries (bun:sqlite, WAL)
```

One SQLite file is shared by both server processes on the same machine — one
writer (the collector), concurrent readers (the web backend).

## Usage

### With Nix (recommended)

```sh
nix run github:<you>/super-simple-osu-team-dashboard
```

or build first, then run the separate processes:

```sh
nix build github:<you>/super-simple-osu-team-dashboard
result/bin/dashboard-web
result/bin/dashboard-collector   # production runs them as separate processes
```

Requirements at runtime:

1. A configuration file (default `./team.toml` in the working directory; or
   `--config <path>` / `TEAM_CONFIG` env). See `config.example.toml`:

   ```toml
   team_id = 1234                # required: osu! team id (positive integer)
   # rate_divider = 2            # request budget = 60/divider per minute (default 2)
   # score_poll_base_seconds = 5 # effective feed interval = base × divider (10 s by default)
   # database_path = "./data/team.sqlite"
   # port = 3000
   ```

2. Environment credentials (never in the TOML):

   ```sh
   export OSU_CLIENT_ID=...      # from https://osu.ppy.sh/home/account/edit#oauth
   export OSU_CLIENT_SECRET=...
   ```

3. The working directory holds the state: `./team.toml` and `./data/team.sqlite`
   are created on first start, then hourly profile collections and captured
   team scores accumulate (graphs fill progressively — no artificial backfill).

### Without Nix

Requires [Bun](https://bun.sh/):

```sh
bun install
bun run dev        # collector + web backend together, with hot reload for the web
bun run build      # bundle the frontend into apps/web/public/assets
bun run start      # production: collector and web as separate processes
bun run test       # Bun test runner
bun run typecheck  # tsc --noEmit (strict)
```

### Container

The flake package is self-contained (Bun in the closure, no FHS paths needed),
so it drops directly into a container. The container itself is yours to build;
a minimal sketch using the flake package:

```nix
# your container / OCI image definition
pkgs.dockerTools.buildLayeredImage {
  name = "osu-team-dashboard";
  config = {
    Cmd = [ "${osuTeamDashboard}/bin/dashboard" ];
    Env = [
      "OSU_CLIENT_ID=..."
      "OSU_CLIENT_SECRET=..."
      "TEAM_CONFIG=/etc/team.toml"
    ];
  };
}
```

Only mount/provide a writable working directory (or set `database_path` in the
TOML to a mounted path) and the two environment variables.

## What it collects

- **Team sync** at startup and each UTC hour: `GET /teams/{id}` — identity,
  flag/logo, roster (leader + members) and the team's default game mode come
  from the API; nothing team-specific is hardcoded.
- **Score feed**: `GET /scores` without a ruleset filter (covers all four
  modes), ordered batches of up to 1,000 passed scores. Scores of current team
  members are retained; the returned `cursor_string` is persisted atomically
  with the scores it covers, so a stopped collector resumes where it left off.
- **Hourly profiles**: at each UTC hour, all members are fetched in chunks of
  ≤ 50 via `GET /users?ids[]=` and one snapshot per member per game mode is
  stored — or the failed attempt is recorded and nothing partial is published.
- **Rate limiting**: one sequential request queue, `rate_divider × 1 s`
  minimum spacing and a rolling 60/divider-per-minute budget; ≤ 3 retries for
  network/5xx/429 (honouring `Retry-After`, else exponential backoff), token
  renewal on 401.

## Website

Two pages, **Leaderboards** (default) and **Live**, with the game-mode selector
shared between them:

- Leaderboards: metric selector (PP, ranked score, total score, play count,
  accuracy, play time, total hits), a Chart.js line graph of every member's
  metric over the last 24 hours or 7 days (same UTC hour), missing observations
  shown as gaps, and a ranked table with Δ23 h / Δ6 d differences.
- Live: the 10 newest captured completed plays for the selected mode and an
  extended team leaderboard sortable by PP, scores, accuracy, play count,
  play time, total hits, global rank and grade counts.
- Live updates via `GET /api/events` (SSE): the backend watches the database
  change sequence every 2 s; browsers refresh only the affected data.
- Vanilla TypeScript, no frontend framework, no cookies or client-side
  business logic; system light/dark theme, WCAG 2.2 AA target, reduced-motion
  aware.

## Development

```sh
nix develop        # Bun toolchain (nothing installed on the host)
```

Tests (`bun test`) cover configuration validation, SQLite transactions and
integrity, metric calculations, ranking rules, time-axis selection, the
request scheduler (spacing, budget, retries, backoff), score-feed cursor
handling, hourly collection chunking (1/50/51/5000 members), rollback on
failed collections, and an end-to-end run against a mock osu! backend.

## License

AGPL-3.0 — see [LICENSE](LICENSE). osu! and the osu! logo are trademarks of
ppy Pty Ltd; this is an unofficial fan project.
