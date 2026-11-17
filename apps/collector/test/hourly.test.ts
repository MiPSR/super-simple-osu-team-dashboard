import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase, migrate, Queries, logicalHourOf } from "@osu-team/database";
import { Scheduler } from "../src/index.ts";
import { OsuClient } from "../src/index.ts";
import { TeamRoster } from "../src/index.ts";
import { HourlyCollector, USERS_CHUNK_SIZE } from "../src/index.ts";
import type { TeamJson, UserJson } from "../src/index.ts";
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

function makeUser(id: number): UserJson {
  return {
    id,
    username: `user-${id}`,
    avatar_url: null,
    country_code: "XX",
    statistics_rulesets: {
      osu: {
        pp: 1000 + id,
        global_rank: id,
        country_rank: 1,
        accuracy: 0.975,
        maximum_combo: 600,
        ranked_score: 1_000_000,
        total_score: 2_000_000,
        total_hits: 300_000,
        play_count: 10_000,
        play_time: 500_000,
        replays_watched_by_others: 3,
        level: { current: 100, progress: 50 },
        grade_counts: { a: 900, s: 200, sh: 20, ss: 10, ssh: 2 },
        count_300: 1_000_000,
        count_100: 50_000,
        count_50: 5_000,
        count_miss: 1_000,
      },
      taiko: null,
      fruits: null,
      mania: null,
    },
  };
}

function makeTeam(ids: number[]): TeamJson {
  const [leaderId, ...memberIds] = ids;
  const toUser = (id: number) => ({ id, username: `user-${id}`, avatar_url: null, country_code: "XX" });
  return {
    id: 42,
    name: "team",
    short_name: "TM",
    flag_url: null,
    cover_url: null,
    default_ruleset_id: 0,
    leader: toUser(leaderId ?? 1),
    members: memberIds.map(toUser),
  };
}

interface BackendOptions {
  rosterIds: number[];
  /** Fail /users requests: two transient 503s, then a permanent 404 (terminates backoff). */
  failUsers?: boolean;
  /** Omit these user ids from /users responses (incomplete data). */
  omitUsers?: number[];
}

function makeBackend(options: BackendOptions) {
  const usersCalls: number[][] = []; // ids per call
  let token = "t";
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/oauth/token")) {
      return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: 86400 });
    }
    if (url.includes("/api/v2/teams/")) {
      return jsonResponse(makeTeam(options.rosterIds));
    }
    if (url.includes("/api/v2/users?")) {
      const matches = url.match(/ids%5B%5D=(\d+)/g) ?? [];
      const ids = matches.map((m) => Number(m.split("=")[1]));
      usersCalls.push(ids);
      if (options.failUsers) {
        // Two transient 5xx, then a permanent 404 so scheduler backoff terminates.
        return usersCalls.length <= 2 ? jsonResponse({ error: "upstream down" }, 503) : jsonResponse({}, 404);
      }
      const returned = ids.filter((id) => !options.omitUsers?.includes(id));
      return jsonResponse({ users: returned.map(makeUser) });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
  return { fetchFn, usersCalls };
}

let db: SqliteDatabase;
let queries: Queries;
let clock: FakeClock;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  queries = new Queries(db);
  clock = new FakeClock();
});

async function makeCollector(options: BackendOptions, divider = 1, nowFn?: () => string): Promise<{ collector: HourlyCollector; backend: ReturnType<typeof makeBackend>; roster: TeamRoster }> {
  const backend = makeBackend(options);
  const scheduler = new Scheduler(divider, clock);
  const client = new OsuClient({ scheduler, clock, fetchFn: backend.fetchFn, logger: silentLogger, token: "t" });
  const roster = new TeamRoster(client, queries, 42, silentLogger);
  const collector = nowFn
    ? new HourlyCollector(client, queries, roster, silentLogger, nowFn)
    : new HourlyCollector(client, queries, roster, silentLogger);
  return { collector, backend, roster };
}

const HOUR = Date.UTC(2026, 0, 1, 5, 0, 0);

describe("hourly collections (3.7 – 3.10, 8.3)", () => {
  test.each([
    [1, 1],
    [50, 1],
    [51, 2],
    [5000, 100],
  ])("roster of %i members chunks into %i /users requests of ≤ 50 (3.7)", async (members, expectedCalls) => {
    const ids = Array.from({ length: members }, (_, i) => i + 1);
    const { collector, backend } = await makeCollector({ rosterIds: ids });
    const collectionId = await collector.collect(HOUR);
    expect(collectionId).not.toBeNull();
    expect(backend.usersCalls).toHaveLength(expectedCalls);
    for (const call of backend.usersCalls) {
      expect(call.length).toBeLessThanOrEqual(USERS_CHUNK_SIZE);
    }
    expect(queries.getCollection(collectionId as number)?.status).toBe("published");
    // 4 modes per member: 1×4, 50×4, 51×4, 5000×4 snapshots.
    const rows = db.query("SELECT COUNT(*) AS n FROM profile_snapshots").get() as { n: number };
    expect(rows.n).toBe(members * 4);
  });

  test("a logical hour is published exactly once with the collection's UTC hour (3.8)", async () => {
    const { collector } = await makeCollector({ rosterIds: [1, 2] });
    const collectionId = (await collector.collect(HOUR + 30_000)) as number;
    const row = queries.getCollection(collectionId);
    expect(row?.logicalHour).toBe(logicalHourOf(HOUR));
    expect(row?.status).toBe("published");
  });

  test("failed member requests roll back: no partial snapshot is published (3.9)", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1); // two chunks; both fail
    const { collector } = await makeCollector({ rosterIds: ids, failUsers: true });
    const collectionId = await collector.collect(HOUR);
    expect(collectionId).toBeNull();
    const rows = db.query("SELECT COUNT(*) AS n FROM profile_snapshots").get() as { n: number };
    expect(rows.n).toBe(0);
    expect(queries.getLatestPublishedCollection()).toBeNull();
    const attempts = db.query("SELECT status, COUNT(*) AS n FROM collections GROUP BY status").all() as Array<{ status: string; n: number }>;
    expect(attempts.some((a) => a.status === "failed")).toBe(true);
  });

  test("incomplete /users responses fail the collection (3.7)", async () => {
    const { collector } = await makeCollector({ rosterIds: [1, 2, 3], omitUsers: [3] });
    const collectionId = await collector.collect(HOUR);
    expect(collectionId).toBeNull();
    const failed = db.query("SELECT error FROM collections WHERE status = 'failed'").get() as { error: string } | null;
    expect(failed?.error).toContain("omitted");
  });

  test("missed logical hours are recorded while a collection overruns (3.10)", async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => i + 1);
    const { collector } = await makeCollector({ rosterIds: ids });
    await collector.collect(HOUR);
    // Two hours pass while nothing else ran.
    collector.recordMissedHours(HOUR + 3 * 3_600_000);
    const missed = db.query("SELECT logical_hour FROM collections WHERE status = 'missed' ORDER BY logical_hour").all() as Array<{ logical_hour: number }>;
    expect(missed.map((m) => m.logical_hour)).toEqual([logicalHourOf(HOUR) + 3600, logicalHourOf(HOUR) + 7200]);
  });

  test("snapshots record actual gathered timestamps separately from the logical hour (3.8)", async () => {
    let now = HOUR + 5_000;
    const { collector } = await makeCollector(
      { rosterIds: [1] },
      1,
      () => new Date(now).toISOString(),
    );
    now = HOUR + 30_000;
    const collectionId = (await collector.collect(HOUR)) as number;
    const rows = db.query("SELECT DISTINCT gathered_at FROM profile_snapshots WHERE collection_id = ?").all(collectionId) as Array<{ gathered_at: string }>;
    expect(rows).toHaveLength(1);
    expect(Date.parse(rows[0]!.gathered_at)).toBe(HOUR + 30_000);
    // The logical hour is the hour start, not the gathering instant (3.8).
    expect(queries.getCollection(collectionId)?.logicalHour).toBe(logicalHourOf(HOUR));
  });
});
