import type { GameMode } from "@osu-team/contracts";
import type { Scheduler, RequestPriority } from "./scheduler.ts";

/**
 * osu!api v2 client: typed requests routed through the shared sequential
 * scheduler (spec 3.5, 3.6), authenticated with a Bearer token provided by the
 * configuration. No token acquisition lives here.
 *
 * Endpoint shapes verified against the osu! api wiki (osu.ppy.sh/docs):
 * - GET  /teams/{team}        → TeamExtended (leader + members, flag_url, default_ruleset_id)
 * - GET  /scores?cursor_string= → { scores: Score[], cursor_string } (≤1000, all rulesets
 *   when the `ruleset` parameter is omitted; unchanged cursor means caught up)
 * - GET  /users?ids[]=…       → { users: User[] } (≤50 per request, statistics_rulesets)
 * - GET  /beatmaps/{id}       → BeatmapExtended (incl. beatmapset)
 */

export const DEFAULT_API_BASE = "https://osu.ppy.sh/api/v2";

export class OsuPermanentError extends Error {}

export type FetchLike = typeof fetch;

export interface TeamJson {
  id: number;
  name: string;
  short_name: string;
  flag_url: string | null;
  cover_url: string | null;
  default_ruleset_id: number;
  leader: UserJson | null;
  members: UserJson[];
}

export interface UserJson {
  id: number;
  username: string;
  avatar_url: string | null;
  country_code: string | null;
  country?: { code: string; name?: string } | null;
  statistics_rulesets?: Record<string, UserStatisticsJson | null> | null;
}

export interface UserStatisticsJson {
  pp: number | null;
  global_rank: number | null;
  country_rank: number | null;
  accuracy: number | null;
  maximum_combo: number | null;
  ranked_score: number | null;
  total_score: number | null;
  total_hits: number | null;
  play_count: number | null;
  play_time: number | null;
  replays_watched_by_others: number | null;
  level: { current: number; progress: number } | null;
  grade_counts: { a?: number; s?: number; sh?: number; ss?: number; ssh?: number } | null;
  count_300: number | null;
  count_100: number | null;
  count_50: number | null;
  count_miss: number | null;
}

export interface ScoreJson {
  id: number;
  user_id: number;
  beatmap_id: number;
  ruleset_id: number;
  ended_at: string;
  started_at: string | null;
  passed: boolean;
  pp: number | null;
  accuracy: number | null;
  total_score: number | null;
  classic_total_score: number | null;
  legacy_total_score: number | null;
  legacy_score_id: number | null;
  type: string | null;
  rank: string;
  max_combo: number | null;
  is_perfect_combo?: boolean | null;
  legacy_perfect?: boolean | null;
  mods: unknown;
  statistics: Record<string, number | undefined> | null;
  beatmap?: BeatmapJson | null;
  beatmapset?: BeatmapsetJson | null;
}

export interface BeatmapJson {
  id: number;
  beatmapset_id: number;
  difficulty_rating: number | null;
  total_length: number | null;
  status: string | null;
  version: string | null;
}

export interface BeatmapsetJson {
  id: number;
  title: string | null;
  artist: string | null;
  covers?: { cover?: string | null; "cover@2x"?: string | null } | null;
}

export interface ScoresPageJson {
  scores: ScoreJson[];
  cursor_string: string | null;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function rulesetIdToModeName(id: number): GameMode | null {
  const table: Record<number, GameMode> = { 0: "osu", 1: "taiko", 2: "fruits", 3: "mania" };
  return table[id] ?? null;
}

export interface OsuClientOptions {
  scheduler: Scheduler;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  fetchFn?: FetchLike;
  logger?: Logger;
  /** Test-only override for mock backends; production uses the official endpoints. */
  apiBase?: string;
  /** Bearer token used for every API request. Acquisition is out of scope here. */
  token?: string;
}

export class OsuClient {
  private readonly fetchFn: FetchLike;
  private readonly clock: { now(): number };
  private readonly logger?: Logger;
  private readonly apiBase: string;

  constructor(private readonly options: OsuClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.logger = options.logger;
    // Production always uses the official endpoint; apiBase exists only for test doubles.
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
  }

  get scheduler(): Scheduler {
    return this.options.scheduler;
  }

  // --------------------------------------------------------------- API (3.5/3.6)

  /** GET an api/v2 path through the scheduler with retry classification. */
  async api<T>(path: string, opts: { priority: RequestPriority; context: string }): Promise<T> {
    return this.options.scheduler.schedule<T>(opts.priority, async () => {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.options.token !== undefined) {
        headers.Authorization = `Bearer ${this.options.token}`;
      }
      let response: Response;
      try {
        response = await this.fetchFn(`${this.apiBase}${path}`, { headers });
      } catch (err) {
        return { kind: "transient", detail: `network error for ${path}: ${(err as Error).message}` };
      }

      if (response.status === 429 || response.status >= 500) {
        let retryAfterMs: number | undefined;
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter !== null) {
          const seconds = Number(retryAfter);
          if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, seconds * 1000);
        }
        return {
          kind: "transient",
          retryAfterMs,
          detail: `${path} returned ${response.status}${retryAfterMs ? ` (Retry-After ${retryAfterMs} ms)` : ""}`,
        };
      }

      if (!response.ok) {
        this.logger?.error(`permanent API failure ${response.status} for ${path} (${opts.context})`);
        return { kind: "permanent", detail: `${path} returned ${response.status} (${opts.context})` };
      }

      return { kind: "ok", value: (await response.json()) as T };
    });
  }

  // ------------------------------------------------------------- endpoints (3.x)

  /** GET /teams/{team} — TeamExtended with leader + members (3.1). */
  getTeam(teamId: number): Promise<TeamJson> {
    return this.api<TeamJson>(`/teams/${teamId}`, { priority: "hourly", context: "team-sync" });
  }

  /** GET /users?ids[]=… — up to 50 users per request with statistics_rulesets (3.7). */
  getUsers(userIds: number[]): Promise<UserJson[]> {
    const params = new URLSearchParams();
    for (const id of userIds) params.append("ids[]", String(id));
    return this.api<{ users: UserJson[] }>(`/users?${params.toString()}`, {
      priority: "hourly",
      context: "hourly-profiles",
    }).then((r) => r.users);
  }

  /** GET /scores — global passed-score feed, all rulesets (3.2). */
  getScores(cursorString: string | null): Promise<ScoresPageJson> {
    const path = cursorString === null ? "/scores" : `/scores?cursor_string=${encodeURIComponent(cursorString)}`;
    return this.api<ScoresPageJson>(path, { priority: "feed", context: "score-feed" });
  }

  /** GET /beatmaps/{id} — low-priority metadata enrichment (3.11). */
  getBeatmap(beatmapId: number): Promise<BeatmapJson & { beatmapset?: BeatmapsetJson | null }> {
    return this.api<BeatmapJson & { beatmapset?: BeatmapsetJson | null }>(`/beatmaps/${beatmapId}`, {
      priority: "beatmap",
      context: "beatmap-enrichment",
    });
  }
}
