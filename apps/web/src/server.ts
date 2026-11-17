import { Elysia } from "elysia";
import type { GameMode, MetricKey, Period, LiveSortKey } from "@osu-team/contracts";
import {
  GAME_MODES,
  METRIC_KEYS,
  LIVE_SORT_KEYS,
  PERIODS,
  isGameMode,
  isMetricKey,
  isPeriod,
  isLiveSortKey,
  MODE_LABELS,
} from "@osu-team/contracts";
import type { Queries, TeamRow } from "@osu-team/database";
import { openDatabase, migrate, Queries as QueriesClass } from "@osu-team/database";
import { buildLeaderboard, buildLivePlays, buildLiveLeaderboard, isoFromLogicalHour } from "./leaderboards.ts";

export interface WebOptions {
  databasePath: string;
  port: number;
  publicDir: string;
}

export interface PublicTeam {
  id: number;
  name: string;
  shortName: string;
  flagUrl: string | null;
  coverUrl: string | null;
  defaultMode: GameMode;
  syncedAt: string | null;
}

/** The frontend receives only public team information through the API (2.6). */
export function toPublicTeam(team: TeamRow | null): PublicTeam {
  if (!team) {
    return { id: null as unknown as number, name: "Unknown team", shortName: "", flagUrl: null, coverUrl: null, defaultMode: "osu", syncedAt: null };
  }
  return {
    id: team.id,
    name: team.name,
    shortName: team.shortName,
    flagUrl: team.flagUrl,
    coverUrl: team.coverUrl,
    defaultMode: team.defaultMode,
    syncedAt: team.syncedAt,
  };
}

/** SSE: the web backend checks the change sequence every 2 s (6.5). */
class LiveEvents {
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private lastSeq = -1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queries: Queries,
    private readonly encoder = new TextEncoder(),
  ) {}

  start(): void {
    const initial = this.queries.getChangeSequence();
    this.lastSeq = initial.seq;
    this.timer = setInterval(() => this.tick(), 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        /* client already gone */
      }
    }
    this.clients.clear();
  }

  private tick(): void {
    let seq: number;
    let kind: string | null;
    try {
      const state = this.queries.getChangeSequence();
      seq = state.seq;
      kind = state.kind;
    } catch {
      return; // database not ready yet — keep the stream alive
    }
    if (seq === this.lastSeq) return;
    this.lastSeq = seq;
    this.broadcast({ type: "data-changed", seq, kind, at: new Date().toISOString() });
  }

  private broadcast(payload: unknown): void {
    const data = `event: data-changed\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.enqueue(this.encoder.encode(data));
      } catch {
        this.clients.delete(client);
      }
    }
  }

  stream(): Response {
    const encoder = this.encoder;
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self.clients.add(controller);
        controller.enqueue(encoder.encode(`retry: 3000\n\n`));
      },
      cancel() {
        // Removed from the set lazily on enqueue failure.
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

export function createApp(options: WebOptions) {
  // The web backend is a reader; migrations run only to create the schema on
  // first startup before the collector has written anything.
  const db = openDatabase({ path: options.databasePath });
  migrate(db);
  const queries = new QueriesClass(db);
  const events = new LiveEvents(queries);
  events.start();

  const renderPage = async (file: string, status = 200): Promise<Response> => {
    const path = `${options.publicDir}/${file}`;
    const f = Bun.file(path);
    if (!(await f.exists())) {
      return new Response(`page not built: ${file} (run \`bun run build\`)`, { status: 500 });
    }
    let html = await f.text();
    // Initial server-rendered bootstrap: team identity, navigation and the
    // available statistics (6.1). Never any credentials.
    html = html.replace(
      "__BOOTSTRAP__",
      JSON.stringify({
        team: toPublicTeam(queries.getTeam()),
        modes: GAME_MODES.map((m) => ({ id: m, label: MODE_LABELS[m] })),
        metrics: METRIC_KEYS,
        periods: PERIODS,
        sorts: LIVE_SORT_KEYS,
      }).replace(/</g, "\\u003c"),
    );
    return new Response(html, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };

  const app = new Elysia()
    .get("/", () => renderPage("index.html"))
    .get("/live", () => renderPage("live.html"))
    .get("/style.css", () => Bun.file(`${options.publicDir}/style.css`))
    .get("/assets/*", ({ params }) => {
      const name = (params as { "*": string })["*"];
      const file = Bun.file(`${options.publicDir}/assets/${name}`);
      return file.exists().then((exists) => (exists ? file : new Response("Not found", { status: 404 })));
    })
    // ------------------------------------------------------------------ API
    .get("/api/team", () => new Response(JSON.stringify(toPublicTeam(queries.getTeam())), { headers: { "Content-Type": "application/json" } }))
    .get("/api/leaderboards", ({ query }) => {
      const mode = isGameMode(query.mode) ? (query.mode as GameMode) : null;
      const metric = isMetricKey(query.metric) ? (query.metric as MetricKey) : null;
      const period = isPeriod(query.period) ? (query.period as Period) : null;
      if (query.mode !== undefined && mode === null) return new Response("invalid mode", { status: 400 });
      if (query.metric !== undefined && metric === null) return new Response("invalid metric", { status: 400 });
      if (query.period !== undefined && period === null) return new Response("invalid period", { status: 400 });
      const body = buildLeaderboard(
        queries,
        mode ?? toPublicTeam(queries.getTeam()).defaultMode,
        metric ?? "pp",
        period ?? "24h",
      );
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    })
    .get("/api/live/plays", ({ query }) => {
      const mode = isGameMode(query.mode) ? (query.mode as GameMode) : null;
      if (query.mode !== undefined && mode === null) return new Response("invalid mode", { status: 400 });
      let limit = 10;
      if (query.limit !== undefined) {
        const parsed = Number(query.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) return new Response("invalid limit", { status: 400 });
        limit = parsed;
      }
      const body = buildLivePlays(queries, mode ?? toPublicTeam(queries.getTeam()).defaultMode, limit);
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    })
    .get("/api/live/leaderboard", ({ query }) => {
      const mode = isGameMode(query.mode) ? (query.mode as GameMode) : null;
      const sort = isLiveSortKey(query.sort) ? (query.sort as LiveSortKey) : null;
      if (query.mode !== undefined && mode === null) return new Response("invalid mode", { status: 400 });
      if (query.sort !== undefined && sort === null) return new Response("invalid sort", { status: 400 });
      const body = buildLiveLeaderboard(queries, mode ?? toPublicTeam(queries.getTeam()).defaultMode, sort ?? "pp");
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    })
    .get("/api/events", () => events.stream());

  return { app, events, queries };
}

export { isoFromLogicalHour };
