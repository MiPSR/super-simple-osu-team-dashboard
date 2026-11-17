import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase, migrate, Queries } from "@osu-team/database";
import { Scheduler } from "../src/index.ts";
import { OsuClient } from "../src/index.ts";
import { TeamRoster } from "../src/index.ts";
import { ScoreFeed } from "../src/index.ts";
import type { ScoreJson, TeamJson } from "../src/index.ts";
import type { Database as SqliteDatabase } from "bun:sqlite";

class FakeClock {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeScore(id: number, userId: number, rulesetId = 0, overrides: Partial<ScoreJson> = {}): ScoreJson {
  return {
    id,
    user_id: userId,
    beatmap_id: 500 + id,
    ruleset_id: rulesetId,
    ended_at: `2026-01-01T1${id % 10}:00:00.000Z`,
    started_at: null,
    passed: true,
    pp: 100 + id,
    accuracy: 0.99,
    total_score: 1_000_000 + id,
    classic_total_score: 900_000,
    legacy_total_score: null,
    legacy_score_id: null,
    type: "score_best",
    rank: "S",
    max_combo: 600,
    is_perfect_combo: false,
    legacy_perfect: false,
    mods: [{ acronym: "HD" }],
    statistics: { count_300: 400, count_100: 30, count_50: 2, count_miss: 1 },
    beatmap: { id: 500 + id, beatmapset_id: 9000, difficulty_rating: 5.1, total_length: 180, status: "ranked", version: "Insane" },
    beatmapset: { id: 9000, title: "Song", artist: "Artist", covers: { cover: "https://assets.ppy.sh/c.jpg" } },
    ...overrides,
  };
}

const TEAM: TeamJson = {
  id: 42,
  name: "team",
  short_name: "TM",
  flag_url: null,
  cover_url: null,
  default_ruleset_id: 0,
  leader: { id: 1, username: "leader", avatar_url: null, country_code: "AU" },
  members: [{ id: 2, username: "member", avatar_url: null, country_code: "DE" }],
};

interface BackendOptions {
  scoresPages: Array<{ scores: ScoreJson[]; cursor_string: string }>;
  team?: TeamJson;
}

function makeBackend(options: BackendOptions) {
  let pageIndex = 0;
  const scoreUrls: string[] = [];
  let token = "t";
  let lastCursor: string | null = null;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/oauth/token")) {
      return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: 86400 });
    }
    if (url.includes("/api/v2/teams/")) {
      return jsonResponse(options.team ?? TEAM);
    }
    if (url.includes("/api/v2/scores")) {
      scoreUrls.push(url);
      const page = options.scoresPages[pageIndex];
      pageIndex += 1;
      if (page) {
        lastCursor = page.cursor_string;
        return jsonResponse(page);
      }
      // Feed drained: return the last cursor unchanged (caught up, 3.3).
      return jsonResponse({ scores: [], cursor_string: lastCursor });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
  return { fetchFn, scoreUrls };
}

let db: SqliteDatabase;
let queries: Queries;
let client: OsuClient;
let roster: TeamRoster;
let clock: FakeClock;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  queries = new Queries(db);
  clock = new FakeClock();
  const scheduler = new Scheduler(1, clock);
  const backend = makeBackend({ scoresPages: [] });
  client = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, tokenProvider: { getAccessToken: async () => "t" } });
  roster = new TeamRoster(client, queries, 42, silentLogger);
  await roster.sync();
});

describe("score feed (3.2, 3.3, 3.4)", () => {
  test("first run initializes the cursor from the latest batch (3.3)", async () => {
    const backend = makeBackend({
      scoresPages: [{ scores: [makeScore(1, 1), makeScore(2, 99)], cursor_string: "c-head" }],
    });
    const scheduler = new Scheduler(1, clock);
    const osu = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, tokenProvider: { getAccessToken: async () => "t" } });
    const feed = new ScoreFeed(osu, queries, roster, 2, silentLogger);
    expect(await feed.pollOnce()).toBe(true); // partial batch ends catch-up
    expect(queries.getState().cursorString).toBe("c-head");
    // Only team members' scores are retained (3.2).
    const rows = db.query("SELECT id FROM scores ORDER BY id").all() as Array<{ id: number }>;
    expect(rows).toEqual([{ id: 1 }]);
  });

  test("unchanged cursor means caught up and does not re-ingest (3.3)", async () => {
    const backend = makeBackend({
      scoresPages: [
        { scores: [makeScore(1, 1)], cursor_string: "c1" },
        { scores: [], cursor_string: "c1" },
      ],
    });
    const scheduler = new Scheduler(1, clock);
    const osu = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, tokenProvider: { getAccessToken: async () => "t" } });
    const feed = new ScoreFeed(osu, queries, roster, 2, silentLogger);
    // First poll: partial head batch → catch-up ends (3.3, 3.4).
    expect(await feed.pollOnce()).toBe(true);
    expect(queries.getState().cursorString).toBe("c1");
    // Second poll: unchanged cursor → caught up, nothing re-ingested (3.3).
    expect(await feed.pollOnce()).toBe(true);
    const rows = db.query("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(queries.getState().cursorString).toBe("c1");
  });

  test("full batches of 1000 are followed up immediately (3.4)", async () => {
    const fullBatch = Array.from({ length: 1000 }, (_, i) => makeScore(i + 1, (i % 2) + 1));
    const backend = makeBackend({
      scoresPages: [
        { scores: fullBatch, cursor_string: "c1" },
        { scores: [makeScore(2000, 2)], cursor_string: "c2" },
        { scores: [], cursor_string: "c2" },
      ],
    });
    const scheduler = new Scheduler(1, clock);
    const osu = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, tokenProvider: { getAccessToken: async () => "t" } });
    const feed = new ScoreFeed(osu, queries, roster, 2, silentLogger);
    await feed.catchUp();
    // The persisted cursor is the last returned cursor; the follow-up batch was ingested.
    expect(queries.getState().cursorString).toBe("c2");
    const rows = db.query("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
    expect(rows.n).toBe(1001); // all 1000 team scores from the full batch + 1 follow-up
  });

  test("repeated scores are stored once (8.3)", async () => {
    const duplicate = makeScore(7, 1);
    const backend = makeBackend({
      scoresPages: [
        { scores: [duplicate], cursor_string: "c1" },
        { scores: [duplicate], cursor_string: "c2" },
        { scores: [], cursor_string: "c2" },
      ],
    });
    const scheduler = new Scheduler(1, clock);
    const osu = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, tokenProvider: { getAccessToken: async () => "t" } });
    const feed = new ScoreFeed(osu, queries, roster, 2, silentLogger);
    await feed.catchUp();
    const rows = db.query("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test("resumes from the persisted cursor after restart (3.4)", async () => {
    queries.ingestScores([], [], "c-saved", "p", "i");
    const backend = makeBackend({
      scoresPages: [{ scores: [makeScore(9, 2)], cursor_string: "c-next" }],
    });
    const scheduler = new Scheduler(1, clock);
    const osu = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, tokenProvider: { getAccessToken: async () => "t" } });
    const feed = new ScoreFeed(osu, queries, roster, 2, silentLogger);
    await feed.catchUp();
    expect(queries.getState().cursorString).toBe("c-next");
  });

  test("beatmap metadata supplied with scores is stored (3.11)", async () => {
    const backend = makeBackend({
      scoresPages: [{ scores: [makeScore(11, 1)], cursor_string: "c1" }],
    });
    const scheduler = new Scheduler(1, clock);
    const osu = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, tokenProvider: { getAccessToken: async () => "t" } });
    const feed = new ScoreFeed(osu, queries, roster, 2, silentLogger);
    await feed.catchUp();
    const rows = db.query("SELECT title, artist, cover_url FROM beatmaps").get() as Record<string, string>;
    expect(rows.title).toBe("Song");
    expect(rows.cover_url).toBe("https://assets.ppy.sh/c.jpg");
  });
});
