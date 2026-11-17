# super-simple-osu-team-dashboard

Unofficial statistics dashboard for an osu! **team**: per-member leaderboards
with hourly history and live recent plays, for all four game modes
(osu!, osu!taiko, osu!catch, osu!mania).

An independent **collector** polls the [osu!api v2](https://osu.ppy.sh/docs/index.html)
with a configured Bearer token into a local SQLite database (WAL), and an
**Elysia** web backend serves the site, JSON endpoints and Server-Sent Events.
Not affiliated with or endorsed by ppy Pty Ltd.

## Architecture

Monorepo with Bun workspaces, TypeScript (`strict: true`) and three components
(per `technical_specs.md`):

```
apps/
  collector/   osu! request scheduler, team sync, score feed,
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
nix run github:MiPSR/super-simple-osu-team-dashboard
```

or build first, then run the separate processes:

```sh
nix build github:MiPSR/super-simple-osu-team-dashboard
result/bin/dashboard-web
result/bin/dashboard-collector   # production runs them as separate processes
```

The app reads its entire configuration from `data/config.toml` in the working
directory — no environment variables, no CLI flags:

```sh
mkdir -p data
cp config.example.toml data/config.toml
$EDITOR data/config.toml
```

```toml
team_id = 1                     # required: osu! team id
client_id = 1                   # required: osu! OAuth application id
client_secret = "..."           # required: osu! OAuth application secret
refresh_token = "..."           # required: your stored osu! refresh token
rate_divider = 2                # optional: request budget = 60/divider per minute
```

The collector exchanges the stored refresh token for an access token and
writes the rotated refresh token osu! returns back into this file. A rejected
token exits the process — replace the value and restart. There is no token
acquisition flow in the app; how you obtain the refresh token (one-time
OAuth authorization with your osu! account) is up to you.

The SQLite database is created beside it (`data/team.sqlite`) on first start.
`data/` is gitignored — locally it holds your config and state; on a server
(or bind-mounted into a container) it is the same one-directory layout.

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
so it drops directly into a NixOS container (`containers.<name>` with
`bindMounts`) or any other container. The container itself is yours to build;
it needs exactly one data directory, bind-mounted, with the working directory
set to it so `data/config.toml` and `data/team.sqlite` live there:

```nix
containers.osu-dash = {
  bindMounts.data = {
    hostPath = "/var/lib/osu-dashboard";
    mountPoint = "/data";
  };
  config = {
    systemd.services.dashboard = {
      after = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        # the flake package, e.g. inputs.self.packages.x86_64-linux.default
        ExecStart = "${inputs.self.packages.x86_64-linux.default}/bin/dashboard";
        WorkingDirectory = "/data";
      };
    };
  };
};
```

The single requirement: the process working directory must contain
`data/config.toml` (and thus `data/team.sqlite`).

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
  minimum spacing and a rolling 60/divider-per-minute budget; transient
  failures (network/5xx/429) retry with exponential backoff honouring
  `Retry-After`, per the osu! wiki good practices; other 4xx fail immediately.

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
