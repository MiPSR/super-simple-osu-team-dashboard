import { describe, test, expect, beforeEach } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { openDatabase, migrate, Queries, logicalHourOf, type ScoreInput, type SnapshotInput } from "../src/index.ts";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { RULESET_IDS } from "@osu-team/contracts";

let db: SqliteDatabase;
let queries: Queries;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  queries = new Queries(db);
});

function baseSnapshot(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    collectionId: 1,
    userId: 1,
    mode: "osu",
    gatheredAt: "2026-01-01T00:00:00.000Z",
    pp: 1000,
    globalRank: 100,
    countryRank: 5,
    accuracy: 0.9812,
    maxCombo: 700,
    rankedScore: 1_000_000n,
    totalScore: 2_000_000n,
    totalHits: 300_000n,
    playCount: 10_000,
    playTime: 500_000,
    replayViews: 12,
    level: 101,
    levelProgress: 40,
    gradeSs: 10,
    gradeSsh: 2,
    gradeS: 200,
    gradeSh: 20,
    gradeA: 900,
    count300: 1_000_000n,
    count100: 50_000n,
    count50: 5_000n,
    countMiss: 1_000n,
    ...overrides,
  };
}

function baseScore(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    id: 1000,
    playerId: 1,
    beatmapId: 42,
    mode: "osu",
    endedAt: "2026-01-01T12:00:00.000Z",
    startedAt: "2026-01-01T11:59:00.000Z",
    pp: 234.5,
    accuracy: 0.975,
    totalScore: 1_000_000,
    classicTotalScore: 900_000,
    legacyTotalScore: null,
    legacyScoreId: null,
    scoreType: "score_best",
    grade: "S",
    combo: 650,
    perfectCombo: false,
    mods: '["HD"]',
    hasReplay: true,
    count300: 500,
    count100: 20,
    count50: 2,
    countGeki: 0,
    countKatu: 0,
    countMiss: 1,
    capturedAt: "2026-01-01T12:00:05.000Z",
    ...overrides,
  };
}

describe("migrations (4.10)", () => {
  test("creates the schema and is idempotent", () => {
    expect(queries.getTeam()).toBeNull();
    expect(() => migrate(db)).not.toThrow();
  });

  test("foreign keys are enforced", () => {
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    // Snapshot referencing a non-existent collection must fail.
    expect(() => queries.insertSnapshots([baseSnapshot()])).toThrow();
  });

  test("WAL journal mode is enabled for a file database (1.5)", () => {
    const path = `${import.meta.dir}/wal-test.sqlite`;
    try {
      const fileDb = openDatabase({ path });
      expect((fileDb.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      fileDb.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        const filePath = `${import.meta.dir}/wal-test.sqlite${suffix}`;
        if (existsSync(filePath)) unlinkSync(filePath);
      }
    }
  });
});

describe("team and members (4.1, 4.2, 3.12)", () => {
  test("upserts team identity", () => {
    queries.upsertTeam({ id: 1, name: "team", shortName: "TM", flagUrl: "u", coverUrl: "c", defaultMode: "mania", syncedAt: "t1" });
    queries.upsertTeam({ id: 1, name: "team2", shortName: "TM2", flagUrl: "u2", coverUrl: null, defaultMode: "osu", syncedAt: "t2" });
    const team = queries.getTeam();
    expect(team?.name).toBe("team2");
    expect(team?.defaultMode).toBe("osu");
  });

  test("removed members become former and keep history", () => {
    queries.upsertMembers(
      [
        { userId: 1, username: "a", avatarUrl: null, countryCode: "DE" },
        { userId: 2, username: "b", avatarUrl: null, countryCode: null },
      ],
      "2026-01-01T00:00:00.000Z",
    );
    queries.upsertMembers([{ userId: 1, username: "a2", avatarUrl: "av", countryCode: "DE" }], "2026-01-02T00:00:00.000Z");
    queries.deactivateAbsentMembers([1]);
    expect(queries.getActiveMemberIds()).toEqual([1]);
    const former = queries.getMember(2);
    expect(former?.status).toBe("former");
    expect(former?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(queries.getMember(1)?.username).toBe("a2");
  });
});

describe("big integer storage (4.5)", () => {
  test("stores values beyond the safe range without precision loss", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    queries.startCollection(1000, 1, "t");
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    queries.insertSnapshots([baseSnapshot({ totalScore: big })]);
    const values = queries.getSnapshotValues("total_score", "osu", [1]);
    const v = values.get(1)?.get(1);
    expect(v).toBe(big);
  });

  test("stores NULL for unavailable values (4.5)", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    queries.startCollection(1000, 1, "t");
    queries.insertSnapshots([baseSnapshot({ pp: null, globalRank: null })]);
    expect(queries.getSnapshotValues("pp", "osu", [1]).get(1)?.get(1)).toBeNull();
    expect(queries.getSnapshotValues("global_rank", "osu", [1]).get(1)?.get(1)).toBeNull();
  });
});

describe("collections (4.3, 3.9, 3.10)", () => {
  test("one published collection per logical hour", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    const id1 = queries.startCollection(3600, 1, "t");
    queries.publishHourlyCollection({ collectionId: id1, snapshots: [baseSnapshot({ collectionId: id1 })], finishedAtIso: "t" });
    expect(queries.getLatestPublishedCollection()?.logicalHour).toBe(3600);

    const id2 = queries.startCollection(3600, 1, "t");
    expect(() =>
      queries.publishHourlyCollection({ collectionId: id2, snapshots: [baseSnapshot({ collectionId: id2 })], finishedAtIso: "t2" }),
    ).toThrow();
    const failed = queries.getCollection(id2);
    expect(failed?.status).toBe("failed"); // rolled back, marked failed
  });

  test("failed collections publish no partial snapshots (3.9)", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    const id = queries.startCollection(3600, 1, "t");
    queries.insertSnapshots([baseSnapshot({ collectionId: id })]);
    // publish fails (no committed state change), then the collection is failed
    queries.failCollection(id, "t2", "users endpoint failed");
    const row = queries.getCollection(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("users endpoint");
    expect(queries.getLatestPublishedCollection()).toBeNull();
  });

  test("missed hours are recorded (3.10)", () => {
    queries.markMissedHour(7200, "t", "skipped: previous collection still running");
    const row = queries.getCollection(1);
    expect(row?.status).toBe("missed");
  });
});

describe("scores (4.6, 3.3)", () => {
  test("ingests scores with the cursor atomically; repeated scores are idempotent", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    queries.ingestScores([baseScore()], [], "c1", "p1", "i1");
    expect(queries.getState().cursorString).toBe("c1");
    // Same score ingested again (cursor advanced) — no duplicate row.
    queries.ingestScores([baseScore({ pp: 300 })], [], "c2", "p2", "i2");
    const count = db.query("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
    expect(count.n).toBe(1);
    expect(queries.getState().cursorString).toBe("c2");
  });

  test("uniqueness of score IDs is enforced (4.10)", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    queries.ingestScores([baseScore()], [], "c1", "p", "i");
    const direct = db.query("INSERT INTO scores (id, player_id, beatmap_id, mode, ended_at, grade, mods) VALUES (1000, 1, 1, 'osu', 'x', 'A', '[]')");
    expect(() => direct.run()).toThrow();
  });

  test("recent plays exclude former members (3.12)", () => {
    queries.upsertMembers(
      [
        { userId: 1, username: "active", avatarUrl: null, countryCode: null },
        { userId: 2, username: "former", avatarUrl: null, countryCode: null },
      ],
      "t",
    );
    queries.ingestScores(
      [
        baseScore({ id: 1, playerId: 1, mode: "mania", endedAt: "2026-01-01T12:00:00.000Z" }),
        baseScore({ id: 2, playerId: 2, mode: "mania", endedAt: "2026-01-01T12:01:00.000Z" }),
      ],
      [],
      "c1",
      "p",
      "i",
    );
    queries.deactivateAbsentMembers([1]);
    const plays = queries.getRecentPlays("mania", 10);
    expect(plays).toHaveLength(1);
    expect(plays[0]?.username).toBe("active");
  });

  test("recent plays are ordered by completion time and joined with beatmap metadata", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    queries.ingestScores(
      [
        baseScore({ id: 1, endedAt: "2026-01-01T12:00:00.000Z" }),
        baseScore({ id: 2, endedAt: "2026-01-01T12:30:00.000Z", pp: null }),
      ],
      [
        {
          id: 42,
          beatmapsetId: 7,
          title: "Title",
          artist: "Artist",
          difficultyName: "Insane",
          starRating: 5.55,
          lengthSeconds: 120,
          status: "ranked",
          coverUrl: "cover",
        },
      ],
      "c1",
      "p",
      "i",
    );
    const plays = queries.getRecentPlays("osu", 10);
    expect(plays[0]?.scoreId).toBe(2);
    expect(plays[0]?.pp).toBeNull();
    expect(plays[1]?.beatmapTitle).toBe("Title");
    expect(plays[1]?.starRating).toBe(5.55);
  });

  test("missing beatmap IDs are reported for enrichment (3.11)", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    queries.ingestScores([baseScore()], [], "c1", "p", "i");
    expect(queries.getMissingBeatmapIds(10)).toEqual([42]);
    queries.upsertBeatmaps([
      { id: 42, beatmapsetId: 7, title: "T", artist: "A", difficultyName: "D", starRating: 4, lengthSeconds: 100, status: "ranked", coverUrl: "c" },
    ]);
    expect(queries.getMissingBeatmapIds(10)).toEqual([]);
  });

  test("stable/lazer distinctions are preserved (4.6)", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    queries.ingestScores(
      [
        baseScore({ id: 1, legacyScoreId: 555, legacyTotalScore: 12345, scoreType: "score" }),
        baseScore({ id: 2, classicTotalScore: 987654, scoreType: "score_best" }),
      ],
      [],
      "c1",
      "p",
      "i",
    );
    const rows = db.query("SELECT id, legacy_score_id, legacy_total_score, classic_total_score, score_type FROM scores ORDER BY id").all() as Array<Record<string, number | string | null>>;
    expect(rows[0]?.legacy_score_id).toBe(555);
    expect(rows[0]?.legacy_total_score).toBe(12345);
    expect(rows[1]?.classic_total_score).toBe(987654);
  });
});

describe("collector state (4.8)", () => {
  test("change sequence increments on ingestion and publish", () => {
    queries.upsertMembers([{ userId: 1, username: "a", avatarUrl: null, countryCode: null }], "t");
    const before = queries.getChangeSequence().seq;
    queries.ingestScores([baseScore()], [], "c1", "p", "i");
    expect(queries.getChangeSequence().seq).toBeGreaterThan(before);
    const id = queries.startCollection(3600, 1, "t");
    queries.publishHourlyCollection({ collectionId: id, snapshots: [baseSnapshot({ collectionId: id })], finishedAtIso: "t" });
    expect(queries.getChangeSequence().kind).toBe("collection");
  });
});

describe("logical hour helpers (3.8)", () => {
  test("snaps to the UTC hour start", () => {
    expect(logicalHourOf(Date.UTC(2026, 0, 1, 5, 30, 15))).toBe(Date.UTC(2026, 0, 1, 5, 0, 0) / 1000);
  });
});

describe("mode ids (5.2)", () => {
  test("internal mode identifiers cover all four rulesets", () => {
    expect(Object.keys(RULESET_IDS).sort()).toEqual(["fruits", "mania", "osu", "taiko"]);
  });
});
