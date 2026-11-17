import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase, migrate, Queries, logicalHourOf, type SnapshotInput } from "@osu-team/database";
import { competitionRank, buildLeaderboard, buildLiveLeaderboard, isoFromLogicalHour } from "../src/leaderboards.ts";
import type { GameMode, MetricKey, Period, LiveSortKey } from "@osu-team/contracts";

let db: ReturnType<typeof openDatabase>;
let queries: Queries;

const HOUR = 3600;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  queries = new Queries(db);
});

function addMember(userId: number, username: string): void {
  queries.upsertMembers([{ userId, username, avatarUrl: `https://a/${userId}.png`, countryCode: "DE" }], "2026-01-01T00:00:00.000Z");
}

/** Publish a collection at the given logical hour with one snapshot per member. */
function publishAt(hour: number, values: Array<{ userId: number; pp: number | null; accuracy?: number | null; playTime?: number | null; globalRank?: number | null; gradeSs?: number | null }>): number {
  const id = queries.startCollection(hour, values.length, new Date(hour * 1000).toISOString());
  const snapshots: SnapshotInput[] = values.map((v) => ({
    collectionId: id,
    userId: v.userId,
    mode: "osu" as GameMode,
    gatheredAt: new Date(hour * 1000).toISOString(),
    pp: v.pp,
    globalRank: v.globalRank ?? null,
    countryRank: null,
    accuracy: v.accuracy ?? null,
    maxCombo: null,
    rankedScore: null,
    totalScore: null,
    totalHits: null,
    playCount: null,
    playTime: v.playTime ?? null,
    replayViews: null,
    level: null,
    levelProgress: null,
    gradeSs: v.gradeSs ?? null,
    gradeSsh: null,
    gradeS: null,
    gradeSh: null,
    gradeA: null,
    count300: null,
    count100: null,
    count50: null,
    countMiss: null,
  }));
  queries.publishHourlyCollection({ collectionId: id, snapshots, finishedAtIso: new Date(hour * 1000).toISOString() });
  return id;
}

describe("competition ranking (5.9)", () => {
  test("descending order with ties sharing a position and missing values last", () => {
    const ranks = competitionRank([100, 100, 50, null, 25], false);
    expect(ranks).toEqual([1, 1, 3, null, 4]);
  });

  test("rank-based metrics order ascending (smaller = better)", () => {
    const ranks = competitionRank([1200, 300, 300, null], true);
    expect(ranks).toEqual([3, 1, 1, null]);
  });

  test("bigint values compare without precision loss", () => {
    const ranks = competitionRank([9_007_199_254_740_993n, 9_007_199_254_740_992n], false);
    expect(ranks).toEqual([1, 2]);
  });
});

describe("leaderboard response (5.3 – 5.9, 6.3)", () => {
  test("empty startup returns an empty but valid response (8.4)", () => {
    const result = buildLeaderboard(queries, "osu", "pp", "24h");
    expect(result.collectedAt).toBeNull();
    expect(result.labels).toEqual([]);
    expect(result.series).toEqual([]);
    expect(result.ranking).toEqual([]);
    expect(result.metric.key).toBe("pp");
  });

  test("hourly axis: 23 preceding observations + current point (5.5)", () => {
    addMember(1, "alice");
    addMember(2, "bob");
    const now = Date.UTC(2026, 5, 10, 12, 0, 0) / 1000;
    for (let i = 23; i >= 0; i--) {
      publishAt(now - i * HOUR, [{ userId: 1, pp: 1000 + (23 - i) }, { userId: 2, pp: 2000 }]);
    }
    const result = buildLeaderboard(queries, "osu", "pp", "24h");
    expect(result.labels).toHaveLength(24);
    expect(result.collectedAt).toBe(isoFromLogicalHour(now));
    expect(result.labels[23]).toBe(isoFromLogicalHour(now));
    expect(result.series).toHaveLength(2);
    expect(result.series[0]?.values).toHaveLength(24);
    // Ranking by pp desc: bob (2000) first, alice last value 1023.
    expect(result.ranking[0]?.username).toBe("bob");
    expect(result.ranking[0]?.value).toBe(2000);
    expect(result.ranking[0]?.rank).toBe(1);
    expect(result.ranking[1]?.value).toBe(1023);
    // Δ 23 h: 1023 - 1000.
    expect(result.ranking[1]?.change23h).toBe(23);
    // Δ 6 d: no same-hour collection six days back → null (5.7).
    expect(result.ranking[1]?.change7d).toBeNull();
  });

  test("a collection older than the 24 h window never appears on the hourly axis", () => {
    addMember(1, "alice");
    const now = Date.UTC(2026, 5, 10, 12, 0, 0) / 1000;
    publishAt(now - 2 * 86400, [{ userId: 1, pp: 555 }]);
    publishAt(now, [{ userId: 1, pp: 1000 }]);
    const result = buildLeaderboard(queries, "osu", "pp", "24h");
    expect(result.labels).toHaveLength(1);
    expect(result.series[0]?.values).toEqual([1000]);
  });

  test("missing observations remain gaps, not interpolations (5.7)", () => {
    addMember(1, "alice");
    addMember(2, "bob");
    const now = Date.UTC(2026, 5, 10, 12, 0, 0) / 1000;
    publishAt(now, [{ userId: 1, pp: 1000 }]); // only alice in the current collection
    publishAt(now - HOUR, [{ userId: 2, pp: 500 }]); // only bob one hour earlier
    publishAt(now - 2 * HOUR, [{ userId: 1, pp: 990 }]); // alice again
    const result = buildLeaderboard(queries, "osu", "pp", "24h");
    // Only three published collections exist → three points on the axis.
    expect(result.labels).toHaveLength(3);
    const alice = result.series.find((s) => s.username === "alice");
    const bob = result.series.find((s) => s.username === "bob");
    expect(alice?.values).toEqual([990, null, 1000]);
    expect(bob?.values).toEqual([null, 500, null]);
  });

  test("daily axis: six preceding days at the same UTC hour + current point (5.5)", () => {
    addMember(1, "alice");
    const day = 24 * HOUR;
    const hour0 = Date.UTC(2026, 5, 10, 8, 0, 0) / 1000;
    publishAt(hour0, [{ userId: 1, pp: 700 }]);
    publishAt(hour0 - day, [{ userId: 1, pp: 600 }]);
    publishAt(hour0 - 2 * day, [{ userId: 1, pp: 500 }]);
    publishAt(hour0 - 3 * day, [{ userId: 1, pp: 400 }]);
    publishAt(hour0 - 4 * day, [{ userId: 1, pp: 300 }]);
    publishAt(hour0 - 5 * day, [{ userId: 1, pp: 200 }]);
    publishAt(hour0 - 6 * day, [{ userId: 1, pp: 100 }]);
    // A collection at a different UTC hour must not appear on the daily axis.
    publishAt(hour0 - 3 * day + 5 * HOUR, [{ userId: 1, pp: 9999 }]);
    const result = buildLeaderboard(queries, "osu", "pp", "7d");
    expect(result.labels).toHaveLength(7);
    expect(result.ranking[0]?.value).toBe(700);
    expect(result.ranking[0]?.change7d).toBe(600); // 700 - 100
    expect(result.ranking[0]?.change23h).toBeNull();
  });

  test("metric switching uses the metric's column (5.3)", () => {
    addMember(1, "alice");
    addMember(2, "bob");
    const now = Date.UTC(2026, 5, 10, 12, 0, 0) / 1000;
    publishAt(now, [
      { userId: 1, pp: 1000, accuracy: 0.95 },
      { userId: 2, pp: 2000, accuracy: 0.90 },
    ]);
    const accuracy = buildLeaderboard(queries, "osu", "accuracy", "24h");
    expect(accuracy.ranking[0]?.username).toBe("alice"); // 0.95 > 0.90
    expect(accuracy.metric.unit).toBe("%");
  });
});

describe("live leaderboard (5.11, 5.12)", () => {
  test("sorts by the requested statistic from the newest complete collection", () => {
    addMember(1, "alice");
    addMember(2, "bob");
    const now = Date.UTC(2026, 5, 10, 12, 0, 0) / 1000;
    publishAt(now, [
      { userId: 1, pp: 1000, playTime: 100, globalRank: 500 },
      { userId: 2, pp: 2000, playTime: 9000, globalRank: 100 },
    ]);
    const byPp = buildLiveLeaderboard(queries, "osu", "pp" as LiveSortKey);
    expect(byPp.collectedAt).toBe(isoFromLogicalHour(now));
    expect(byPp.rows.map((r) => r.username)).toEqual(["bob", "alice"]);

    const byRank = buildLiveLeaderboard(queries, "osu", "global_rank" as LiveSortKey);
    expect(byRank.rows.map((r) => r.username)).toEqual(["bob", "alice"]); // ascending (5.9)

    const byPlayTime = buildLiveLeaderboard(queries, "osu", "play_time" as LiveSortKey);
    expect(byPlayTime.rows.map((r) => r.username)).toEqual(["bob", "alice"]);
  });

  test("empty database yields no rows and no timestamp (8.4)", () => {
    const result = buildLiveLeaderboard(queries, "mania", "pp" as LiveSortKey);
    expect(result.collectedAt).toBeNull();
    expect(result.rows).toEqual([]);
  });
});
