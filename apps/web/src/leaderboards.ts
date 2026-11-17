import type { GameMode, MetricKey, Period, LiveSortKey } from "@osu-team/contracts";
import { METRICS, LIVE_SORTS, diffApiNumber, toApiNumber } from "@osu-team/contracts";
import type { Queries, LivePlay, StoredInt } from "@osu-team/database";

/**
 * Leaderboard calculations, performed in the web backend from stored
 * observations only (spec 4.9, 6.3). No derived data is duplicated in the
 * database: ordering, differences and time series are computed here.
 */

export interface RankedEntry {
  userId: number;
  username: string;
  avatarUrl: string | null;
  /** Current selected-metric value (JSON-safe; big ints become strings). */
  value: number | string | null;
  /** Current position — equal values share the same position (5.9). */
  rank: number | null;
  change23h: number | string | null;
  change7d: number | string | null;
}

export interface LeaderboardResponse {
  metric: { key: MetricKey; label: string; unit: string; kind: string; ascending: boolean };
  mode: GameMode;
  period: Period;
  /** Logical timestamp of the latest published collection (5.6). */
  collectedAt: string | null;
  labels: string[];
  series: Array<{ userId: number; username: string; values: Array<number | string | null> }>;
  ranking: RankedEntry[];
}

export function isoFromLogicalHour(logicalHour: number): string {
  return new Date(logicalHour * 1000).toISOString();
}

function compareValues(a: StoredInt, b: StoredInt): number {
  if (typeof a === "bigint" || typeof b === "bigint") {
    const d = BigInt(a) - BigInt(b);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  }
  return a - b;
}

/**
 * Competition ranking (5.9): descending by value (or ascending for rank-based
 * metrics), equal values share the same position, missing values have no rank.
 */
export function competitionRank(values: Array<StoredInt | null>, ascending: boolean): Array<number | null> {
  const indexed = values
    .map((v, i) => ({ i, v }))
    .filter((e): e is { i: number; v: StoredInt } => e.v !== null)
    .sort((a, b) => (ascending ? compareValues(a.v, b.v) : compareValues(b.v, a.v)));

  const ranks: Array<number | null> = values.map(() => null);
  let position = 0;
  let previous: StoredInt | null = null;
  for (let index = 0; index < indexed.length; index++) {
    const entry = indexed[index] as { i: number; v: StoredInt };
    if (index === 0 || compareValues(entry.v, previous as StoredInt) !== 0) {
      position = index + 1;
      previous = entry.v;
    }
    ranks[entry.i] = position;
  }
  return ranks;
}

/** Value at the oldest point of the axis, used as the delta baseline (5.8). */
function oldestValue(
  byCollection: Map<number, StoredInt | null> | undefined,
  collectionIds: number[],
): StoredInt | null {
  // A delta needs a historical point; a lone current observation yields none.
  if (!byCollection || collectionIds.length < 2) return null;
  const oldestId = collectionIds[0];
  if (oldestId === undefined) return null;
  return byCollection.get(oldestId) ?? null;
}

export function buildLeaderboard(
  queries: Queries,
  mode: GameMode,
  metricKey: MetricKey,
  period: Period,
): LeaderboardResponse {
  const metric = METRICS[metricKey];
  const latest = queries.getLatestPublishedCollection();

  if (!latest) {
    return {
      metric: { key: metric.key, label: metric.label, unit: metric.unit, kind: metric.kind, ascending: metric.ascending },
      mode,
      period,
      collectedAt: null,
      labels: [],
      series: [],
      ranking: [],
    };
  }

  // 24h: 23 preceding hourly observations + the current point (5.5), bounded
  // to the 24-hour window so sparse history never leaks into the axis.
  const hourlyRefs = queries
    .getPublishedCollectionsBefore(latest.logicalHour, 24)
    .filter((r) => r.logicalHour >= latest.logicalHour - 23 * 3600)
    .reverse();
  // 7d: six preceding days at the same UTC hour + the current point (5.5).
  const dailyRefs = queries
    .getPublishedCollectionsSameHour(latest.logicalHour, 7)
    .filter((r) => r.logicalHour >= latest.logicalHour - 6 * 86400)
    .reverse();

  const periodRefs = period === "24h" ? hourlyRefs : dailyRefs;
  const labels = periodRefs.map((r) => isoFromLogicalHour(r.logicalHour));
  const periodIds = periodRefs.map((r) => r.id);
  const periodValues = queries.getSnapshotValues(metric.column, mode, periodIds);

  // Deltas need a historical point (5.8); with a single observation they are null.
  const hourlyIds = hourlyRefs.map((r) => r.id);
  const hourlyValues = queries.getSnapshotValues(metric.column, mode, hourlyIds);
  const dailyIds = dailyRefs.map((r) => r.id);
  const dailyValues = queries.getSnapshotValues(metric.column, mode, dailyIds);

  const members = queries.getActiveMembers();

  // Missing observations remain gaps (5.7): absent values are null.
  const series = members.map((m) => {
    const byCollection = periodValues.get(m.userId) ?? new Map<number, StoredInt>();
    return {
      userId: m.userId,
      username: m.username,
      values: periodIds.map((id) => {
        const v = byCollection.get(id);
        return v === undefined || v === null ? null : toApiNumber(v);
      }),
    };
  });

  // Ranking compares the latest published collection's values (5.6, 5.8).
  const currentValues = queries.getSnapshotValues(metric.column, mode, [latest.id]);
  const entries = members.map((m) => {
    const byCollection = currentValues.get(m.userId);
    const value = byCollection?.get(latest.id) ?? null;
    return {
      userId: m.userId,
      username: m.username,
      avatarUrl: m.avatarUrl,
      value,
      change23h: diffApiNumber(value, oldestValue(hourlyValues.get(m.userId), hourlyIds)),
      change7d: diffApiNumber(value, oldestValue(dailyValues.get(m.userId), dailyIds)),
    };
  });

  const rankList = competitionRank(entries.map((e) => e.value), metric.ascending);
  const ranked: RankedEntry[] = entries.map((e, i) => ({ ...e, value: e.value === null ? null : toApiNumber(e.value), rank: rankList[i] as number | null }));

  ranked.sort((a, b) => {
    if (a.rank === null && b.rank === null) return a.username.localeCompare(b.username);
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  });

  return {
    metric: { key: metric.key, label: metric.label, unit: metric.unit, kind: metric.kind, ascending: metric.ascending },
    mode,
    period,
    collectedAt: isoFromLogicalHour(latest.logicalHour),
    labels,
    series,
    ranking: ranked,
  };
}

export interface LivePlaysResponse {
  mode: GameMode;
  /** Completion timestamp of the newest captured play for the mode. */
  updatedAt: string | null;
  plays: LivePlay[];
}

export function buildLivePlays(queries: Queries, mode: GameMode, limit: number): LivePlaysResponse {
  const plays = queries.getRecentPlays(mode, limit);
  return { mode, updatedAt: plays[0]?.endedAt ?? null, plays };
}

export interface LiveLeaderboardRow {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
  values: Record<string, number | string | null>;
}

export interface LiveLeaderboardResponse {
  mode: GameMode;
  sort: LiveSortKey;
  /** Logical timestamp of the newest complete profile collection (5.12). */
  collectedAt: string | null;
  rows: LiveLeaderboardRow[];
}

export function buildLiveLeaderboard(
  queries: Queries,
  mode: GameMode,
  sort: LiveSortKey,
): LiveLeaderboardResponse {
  const definition = LIVE_SORTS[sort];
  const latest = queries.getLatestPublishedCollection();
  if (!latest) {
    return { mode, sort, collectedAt: null, rows: [] };
  }
  const members = queries.getActiveMembers();
  const values = queries.getSnapshotValues(definition.column, mode, [latest.id]);

  const rows: LiveLeaderboardRow[] = members.map((m) => {
    const v = values.get(m.userId)?.get(latest.id) ?? null;
    return {
      userId: m.userId,
      username: m.username,
      avatarUrl: m.avatarUrl,
      countryCode: m.countryCode,
      values: { [sort]: v === null ? null : toApiNumber(v) },
    };
  });

  rows.sort((a, b) => {
    const av = a.values[sort] ?? null;
    const bv = b.values[sort] ?? null;
    if (av === null && bv === null) return a.username.localeCompare(b.username);
    if (av === null) return 1; // missing values sort last
    if (bv === null) return -1;
    const cmp = compareValues(
      typeof av === "string" ? BigInt(av) : av,
      typeof bv === "string" ? BigInt(bv) : bv,
    );
    return definition.ascending ? cmp : -cmp;
  });

  return { mode, sort, collectedAt: isoFromLogicalHour(latest.logicalHour), rows };
}
