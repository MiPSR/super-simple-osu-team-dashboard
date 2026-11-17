import { describe, test, expect } from "bun:test";
import { scoreToInput, userToSnapshots, userToMemberInput } from "../src/index.ts";
import type { ScoreJson, UserJson } from "../src/index.ts";
import { RULESET_IDS } from "@osu-team/contracts";

function makeScore(overrides: Partial<ScoreJson> = {}): ScoreJson {
  return {
    id: 1,
    user_id: 7,
    beatmap_id: 42,
    ruleset_id: 3, // mania
    ended_at: "2026-01-01T10:00:00.000Z",
    started_at: "2026-01-01T09:59:00.000Z",
    passed: true,
    pp: null,
    accuracy: 0.9912,
    total_score: 1_000_000,
    classic_total_score: 950_000,
    legacy_total_score: null,
    legacy_score_id: null,
    type: "score_best",
    rank: "SS",
    max_combo: 999,
    is_perfect_combo: true,
    legacy_perfect: false,
    mods: [{ acronym: "DT" }],
    statistics: { count_300: 1000, count_100: 10, count_50: 1, count_miss: 0, count_geki: 200, count_katu: 20 },
    beatmap: null,
    beatmapset: null,
    ...overrides,
  };
}

describe("score mapping (4.6)", () => {
  test("maps ruleset_id to the internal mode identifier (5.2)", () => {
    expect(scoreToInput(makeScore({ ruleset_id: 0 }))?.mode).toBe("osu");
    expect(scoreToInput(makeScore({ ruleset_id: 1 }))?.mode).toBe("taiko");
    expect(scoreToInput(makeScore({ ruleset_id: 2 }))?.mode).toBe("fruits");
    expect(scoreToInput(makeScore({ ruleset_id: 3 }))?.mode).toBe("mania");
    expect(scoreToInput(makeScore({ ruleset_id: 9 }))).toBeNull();
  });

  test("maps hit statistics with legacy and lazer key styles", () => {
    const input = scoreToInput(makeScore());
    expect(input?.count300).toBe(1000);
    expect(input?.count100).toBe(10);
    expect(input?.count50).toBe(1);
    expect(input?.countGeki).toBe(200);
    expect(input?.countKatu).toBe(20);
    expect(input?.countMiss).toBe(0);

    // Lazer hit-result names (osu! wiki ScoreStatistics).
    const lazer = scoreToInput(makeScore({ statistics: { great: 5, ok: 4, meh: 3, miss: 2, perfect: 1, good: 1 } }));
    expect(lazer?.count300).toBe(5);
    expect(lazer?.count100).toBe(4);
    expect(lazer?.count50).toBe(3);
    expect(lazer?.countGeki).toBe(1);
    expect(lazer?.countKatu).toBe(1);
    expect(lazer?.countMiss).toBe(2);
  });

  test("preserves PP nullability and stable/lazer markers", () => {
    const input = scoreToInput(makeScore());
    expect(input?.pp).toBeNull();
    expect(input?.perfectCombo).toBe(true);
    expect(input?.mods).toBe(JSON.stringify([{ acronym: "DT" }]));
    const stable = scoreToInput(makeScore({ legacy_score_id: 123, legacy_total_score: 98765, type: "score" }));
    expect(stable?.legacyScoreId).toBe(123);
    expect(stable?.legacyTotalScore).toBe(98765);
  });
});

describe("user → snapshots (3.7, 4.4)", () => {
  test("creates one snapshot per game mode with available statistics", () => {
    const user: UserJson = {
      id: 7,
      username: "player",
      avatar_url: "https://a.ppy.sh/7.png",
      country_code: "DE",
      statistics_rulesets: {
        osu: {
          pp: 5000, global_rank: 1234, country_rank: 10, accuracy: 0.9876, maximum_combo: 1200,
          ranked_score: 5_000_000, total_score: 9_000_000, total_hits: 1_000_000,
          play_count: 20_000, play_time: 900_000, replays_watched_by_others: 0,
          level: { current: 102, progress: 30 },
          grade_counts: { a: 1500, s: 400, sh: 50, ss: 30, ssh: 5 },
          count_300: 2_000_000, count_100: 90_000, count_50: 9_000, count_miss: 8_000,
        },
        taiko: null,
        fruits: null,
        mania: null,
      },
    };
    const snapshots = userToSnapshots(user, 99, "2026-01-01T00:00:00.000Z");
    expect(snapshots).toHaveLength(4);
    expect(snapshots.map((s) => s.mode)).toEqual(["osu", "taiko", "fruits", "mania"]);

    const osu = snapshots.find((s) => s.mode === "osu")!;
    expect(osu.collectionId).toBe(99);
    expect(osu.userId).toBe(7);
    expect(osu.pp).toBe(5000);
    expect(osu.accuracy).toBeCloseTo(0.9876); // fraction 0..1 (4.5)
    expect(osu.playTime).toBe(900_000); // seconds
    expect(osu.gradeSsh).toBe(5);
    expect(osu.rankedScore).toBe(5_000_000);

    // Modes without statistics store NULLs (4.5).
    const taiko = snapshots.find((s) => s.mode === "taiko")!;
    expect(taiko.pp).toBeNull();
    expect(taiko.globalRank).toBeNull();
    expect(taiko.totalScore).toBeNull();
  });

  test("member inputs use the country object or fallback code", () => {
    expect(userToMemberInput({ id: 1, username: "x", avatar_url: null, country_code: "AU", country: { code: "BR" } }).countryCode).toBe("BR");
    expect(userToMemberInput({ id: 1, username: "x", avatar_url: null, country_code: "AU" }).countryCode).toBe("AU");
  });

  test("ruleset ids match the documented mapping", () => {
    expect(RULESET_IDS).toEqual({ osu: 0, taiko: 1, fruits: 2, mania: 3 });
  });
});
