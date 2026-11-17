/**
 * Shared definitions: game modes (osu!api v2 "Ruleset"), profile metrics and
 * live leaderboard sort keys. Every component (collector, web backend,
 * frontend) registers or selects metrics through these definitions only.
 */

export type GameMode = "osu" | "taiko" | "fruits" | "mania";

/** Internal mode identifiers (osu!api v2 ruleset names). */
export const GAME_MODES: readonly GameMode[] = ["osu", "taiko", "fruits", "mania"];

/** osu!api v2 ruleset_id integers (osu=0, taiko=1, fruits=2, mania=3). */
export const RULESET_IDS: Record<GameMode, number> = {
  osu: 0,
  taiko: 1,
  fruits: 2,
  mania: 3,
};

export function rulesetIdToMode(id: number): GameMode | null {
  for (const mode of GAME_MODES) {
    if (RULESET_IDS[mode] === id) return mode;
  }
  return null;
}

/** User-visible names of the game modes. */
export const MODE_LABELS: Record<GameMode, string> = {
  osu: "osu!",
  taiko: "osu!taiko",
  fruits: "osu!catch",
  mania: "osu!mania",
};

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === "string" && (GAME_MODES as readonly string[]).includes(value);
}

/** Profile metric keys shown in the leaderboards metric selector. */
export type MetricKey =
  | "pp"
  | "ranked_score"
  | "total_score"
  | "play_count"
  | "accuracy"
  | "play_time"
  | "total_hits";

export type MetricKind = "number" | "duration" | "percent" | "rank";

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  /** Column in the profile_snapshots table. */
  column: string;
  /** Presentation unit for tooltips/subtitles; percentages are formatted client-side. */
  unit: string;
  kind: MetricKind;
  /** Rank-based metrics are ordered ascending (smaller value = better). */
  ascending: boolean;
  /** Initial visible metrics per spec 5.3; additional ones register here. */
  visible: boolean;
}

const METRIC_LIST: MetricDefinition[] = [
  { key: "pp", label: "PP", column: "pp", unit: "pp", kind: "number", ascending: false, visible: true },
  { key: "ranked_score", label: "Ranked score", column: "ranked_score", unit: "score", kind: "number", ascending: false, visible: true },
  { key: "total_score", label: "Total score", column: "total_score", unit: "score", kind: "number", ascending: false, visible: true },
  { key: "play_count", label: "Play count", column: "play_count", unit: "plays", kind: "number", ascending: false, visible: true },
  { key: "accuracy", label: "Accuracy", column: "accuracy", unit: "%", kind: "percent", ascending: false, visible: true },
  { key: "play_time", label: "Play time", column: "play_time", unit: "hours", kind: "duration", ascending: false, visible: true },
  { key: "total_hits", label: "Total hits", column: "total_hits", unit: "hits", kind: "number", ascending: false, visible: true },
];

export const METRICS: Record<MetricKey, MetricDefinition> = Object.fromEntries(
  METRIC_LIST.map((m) => [m.key, m]),
) as Record<MetricKey, MetricDefinition>;

export const METRIC_KEYS: readonly MetricKey[] = METRIC_LIST.map((m) => m.key);

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === "string" && value in METRICS;
}

/** Sort keys for the extended live leaderboard (spec 5.11). */
export type LiveSortKey =
  | MetricKey
  | "global_rank"
  | "grade_ss"
  | "grade_ssh"
  | "grade_s"
  | "grade_sh"
  | "grade_a";

export interface SortDefinition {
  key: LiveSortKey;
  label: string;
  column: string;
  kind: MetricKind;
  ascending: boolean;
}

const SORT_LIST: SortDefinition[] = [
  ...METRIC_LIST.map((m) => ({ key: m.key as LiveSortKey, label: m.label, column: m.column, kind: m.kind, ascending: m.ascending })),
  { key: "global_rank", label: "Global rank", column: "global_rank", kind: "rank", ascending: true },
  { key: "grade_ss", label: "SS", column: "grade_ss", kind: "number", ascending: false },
  { key: "grade_ssh", label: "SSH", column: "grade_ssh", kind: "number", ascending: false },
  { key: "grade_s", label: "S", column: "grade_s", kind: "number", ascending: false },
  { key: "grade_sh", label: "SH", column: "grade_sh", kind: "number", ascending: false },
  { key: "grade_a", label: "A", column: "grade_a", kind: "number", ascending: false },
];

export const LIVE_SORTS: Record<LiveSortKey, SortDefinition> = Object.fromEntries(
  SORT_LIST.map((s) => [s.key, s]),
) as Record<LiveSortKey, SortDefinition>;

export const LIVE_SORT_KEYS: readonly LiveSortKey[] = SORT_LIST.map((s) => s.key);

export function isLiveSortKey(value: unknown): value is LiveSortKey {
  return typeof value === "string" && value in LIVE_SORTS;
}

/** Graph periods (spec 5.4). */
export type Period = "24h" | "7d";
export const PERIODS: readonly Period[] = ["24h", "7d"];
export function isPeriod(value: unknown): value is Period {
  return value === "24h" || value === "7d";
}

/**
 * Convert an internally stored integer (number or bigint, possibly beyond
 * Number.MAX_SAFE_INTEGER) to a JSON-safe representation. Integers outside the
 * safe range are emitted as decimal strings; the frontend displays them as-is.
 */
export function toApiNumber(value: number | bigint | null | undefined): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

/**
 * Convert a SQLite INTEGER that was read as TEXT (to avoid precision loss for
 * values beyond the JavaScript safe-integer range) into number | bigint.
 */
export function parseStoredInt(text: string): number | bigint;
export function parseStoredInt(text: string | null | undefined): number | bigint | null;
export function parseStoredInt(text: string | null | undefined): number | bigint | null {
  if (text === null || text === undefined) return null;
  // REAL columns (e.g. pp) render a decimal point; fall back to Number.
  if (text.includes(".") || text.includes("e") || text.includes("E")) {
    return Number(text);
  }
  const v = BigInt(text);
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

/**
 * Difference between two stored integers, JSON-safe. Precision of the
 * difference itself is preserved when both operands fit the safe range.
 */
export function diffApiNumber(
  current: number | bigint | null,
  previous: number | bigint | null,
): number | string | null {
  if (current === null || previous === null) return null;
  if (typeof current === "bigint" || typeof previous === "bigint") {
    const d = BigInt(current) - BigInt(previous);
    return d >= BigInt(Number.MIN_SAFE_INTEGER) && d <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(d) : d.toString();
  }
  return current - previous;
}

/** Format seconds as a compact human duration, e.g. "12 h 30 m". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${m} m` : `${h} h`;
  if (m > 0) return `${m} m`;
  return `${seconds} s`;
}
