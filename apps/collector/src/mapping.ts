import type { GameMode } from "@osu-team/contracts";
import { RULESET_IDS } from "@osu-team/contracts";
import type { BeatmapInput, ScoreInput, StoredInt } from "@osu-team/database";
import type { BeatmapJson, BeatmapsetJson, ScoreJson, UserJson, UserStatisticsJson } from "./osu.ts";

/**
 * Normalisation of osu!api v2 JSON into stored rows. Score statistics accept
 * both the classic keys (count_300/…) used by api v2 responses and the lazer
 * hit-result keys (great/ok/meh/perfect/good) documented under ScoreStatistics.
 */

export function scoreIdToMode(score: ScoreJson): GameMode | null {
  for (const [mode, id] of Object.entries(RULESET_IDS)) {
    if (id === score.ruleset_id) return mode as GameMode;
  }
  return null;
}

function int(value: number | null | undefined): StoredInt | null {
  return value === null || value === undefined ? null : value;
}

function statCount(stats: Record<string, number | undefined> | null, ...keys: string[]): StoredInt | null {
  if (!stats) return null;
  for (const key of keys) {
    const value = stats[key];
    if (value !== undefined) return value;
  }
  return null;
}

export function scoreToInput(score: ScoreJson, capturedAt: string = new Date().toISOString()): ScoreInput | null {
  const mode = scoreIdToMode(score);
  if (mode === null) return null;
  const stats = score.statistics ?? {};
  return {
    id: score.id,
    playerId: score.user_id,
    beatmapId: score.beatmap_id,
    mode,
    endedAt: score.ended_at,
    startedAt: score.started_at ?? null,
    pp: score.pp ?? null,
    accuracy: score.accuracy ?? null,
    totalScore: int(score.total_score),
    classicTotalScore: int(score.classic_total_score),
    legacyTotalScore: int(score.legacy_total_score),
    legacyScoreId: score.legacy_score_id ?? null,
    scoreType: score.type ?? null,
    grade: score.rank,
    combo: score.max_combo ?? null,
    perfectCombo: Boolean(score.is_perfect_combo ?? score.legacy_perfect ?? false),
    mods: JSON.stringify(score.mods ?? []),
    hasReplay: true,
    count300: statCount(stats, "count_300", "great"),
    count100: statCount(stats, "count_100", "ok"),
    count50: statCount(stats, "count_50", "meh"),
    countGeki: statCount(stats, "count_geki", "perfect"),
    countKatu: statCount(stats, "count_katu", "good"),
    countMiss: statCount(stats, "count_miss", "miss"),
    capturedAt,
  };
}

export function beatmapToInput(
  beatmap: BeatmapJson,
  beatmapset?: BeatmapsetJson | null,
): BeatmapInput {
  return {
    id: beatmap.id,
    beatmapsetId: beatmap.beatmapset_id,
    title: beatmapset?.title ?? null,
    artist: beatmapset?.artist ?? null,
    difficultyName: beatmap.version ?? null,
    starRating: beatmap.difficulty_rating ?? null,
    lengthSeconds: beatmap.total_length ?? null,
    status: beatmap.status ?? null,
    coverUrl: beatmapset?.covers?.cover ?? null,
  };
}

export function userToMemberInput(user: UserJson): {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
} {
  return {
    userId: user.id,
    username: user.username,
    avatarUrl: user.avatar_url ?? null,
    countryCode: user.country?.code ?? user.country_code ?? null,
  };
}

/**
 * One profile snapshot per member per game mode from statistics_rulesets
 * (spec 3.7, 4.4). Unavailable values are stored as NULL (4.5); accuracy is a
 * fraction 0..1 as documented for UserStatistics.accuracy.
 */
export function userToSnapshots(
  user: UserJson,
  collectionId: number,
  gatheredAt: string,
): Array<import("@osu-team/database").SnapshotInput> {
  const snapshots: Array<import("@osu-team/database").SnapshotInput> = [];
  for (const mode of Object.keys(RULESET_IDS) as GameMode[]) {
    const stats = user.statistics_rulesets?.[mode] ?? null;
    snapshots.push(statisticsToSnapshot(stats, mode, user.id, collectionId, gatheredAt));
  }
  return snapshots;
}

export function statisticsToSnapshot(
  stats: UserStatisticsJson | null,
  mode: GameMode,
  userId: number,
  collectionId: number,
  gatheredAt: string,
): import("@osu-team/database").SnapshotInput {
  const grades = stats?.grade_counts ?? {};
  return {
    collectionId,
    userId,
    mode,
    gatheredAt,
    pp: stats?.pp ?? null,
    globalRank: stats?.global_rank ?? null,
    countryRank: stats?.country_rank ?? null,
    accuracy: stats?.accuracy ?? null,
    maxCombo: stats?.maximum_combo ?? null,
    rankedScore: int(stats?.ranked_score),
    totalScore: int(stats?.total_score),
    totalHits: int(stats?.total_hits),
    playCount: int(stats?.play_count),
    playTime: stats?.play_time ?? null,
    replayViews: int(stats?.replays_watched_by_others),
    level: stats?.level?.current ?? null,
    levelProgress: stats?.level?.progress ?? null,
    gradeSs: int(grades.ss),
    gradeSsh: int(grades.ssh),
    gradeS: int(grades.s),
    gradeSh: int(grades.sh),
    gradeA: int(grades.a),
    count300: int(stats?.count_300),
    count100: int(stats?.count_100),
    count50: int(stats?.count_50),
    countMiss: int(stats?.count_miss),
  };
}
