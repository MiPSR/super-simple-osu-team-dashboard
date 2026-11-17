import type { Queries, ScoreInput, BeatmapInput } from "@osu-team/database";
import { nowIso } from "@osu-team/database";
import type { OsuClient, ScoreJson, Logger } from "./osu.ts";
import { scoreToInput, beatmapToInput } from "./mapping.ts";
import type { TeamRoster } from "./roster.ts";

/**
 * Score-feed base interval in seconds — a fixed rule, not a parameter
 * (spec 2.4). The effective polling interval is this × rate_divider.
 */
export const SCORE_POLL_BASE_SECONDS = 5;

/**
 * Score feed collector (spec 3.2, 3.3, 3.4).
 *
 * Polls GET /scores (no ruleset filter — covers all four modes), processes its
 * ordered batches of up to 1,000 passed scores, keeps scores of current team
 * members, and persists the returned cursor atomically with the scores it
 * covers. An unchanged cursor means the feed is caught up. Full batches are
 * followed up immediately through the same scheduler queue.
 */
export class ScoreFeed {
  private running = false;
  totalKept = 0;
  totalBatches = 0;

  constructor(
    private readonly client: OsuClient,
    private readonly queries: Queries,
    private readonly roster: TeamRoster,
    private readonly divider: number,
    private readonly logger: Logger,
    private readonly onScoresChange?: () => void,
  ) {}

  /** Effective regular polling interval = base × divider (2.4). */
  get pollIntervalMs(): number {
    return SCORE_POLL_BASE_SECONDS * this.divider * 1000;
  }

  private static isKept(score: ScoreJson, rosterHas: (id: number) => boolean): boolean {
    return score.passed !== false && rosterHas(score.user_id) && Number.isInteger(score.beatmap_id);
  }

  /**
   * One poll. Returns true when the feed is caught up (unchanged cursor, or a
   * partial batch during catch-up).
   */
  async pollOnce(): Promise<boolean> {
    const startedAt = Date.now();
    const cursor = this.queries.getState().cursorString;
    const firstRun = cursor === null;

    const page = await this.client.getScores(cursor);
    const returnedCursor = page.cursor_string ?? null;

    const kept: ScoreJson[] = page.scores.filter((s) => ScoreFeed.isKept(s, (id) => this.roster.has(id)));
    const caughtUp = !firstRun && returnedCursor === cursor;

    if (!caughtUp) {
      const scoreInputs: ScoreInput[] = [];
      const beatmapInputs = new Map<number, BeatmapInput>();
      const capturedAt = nowIso();
      for (const score of kept) {
        const input = scoreToInput(score, capturedAt);
        if (input === null) continue;
        scoreInputs.push(input);
        if (score.beatmap) {
          beatmapInputs.set(score.beatmap.id, beatmapToInput(score.beatmap, score.beatmapset ?? null));
        }
      }
      // Scores and their cursor commit atomically (3.3, 4.8).
      this.queries.ingestScores(scoreInputs, Array.from(beatmapInputs.values()), returnedCursor, nowIso(), nowIso());
      this.totalKept += scoreInputs.length;
      this.totalBatches += 1;
      this.onScoresChange?.();
      this.logger.info(
        `score feed batch: ${page.scores.length} scores, ${scoreInputs.length} team scores, cursor ${firstRun ? "initialised" : "advanced"} (${Date.now() - startedAt} ms)`,
      );
    } else {
      this.queries.ingestScores([], [], null, nowIso(), nowIso());
    }

    // A full batch may be followed by more; a partial batch ends the catch-up (3.4).
    return caughtUp || page.scores.length < 1000;
  }

  /** Drain the feed: keep requesting while new scores remain available. */
  async catchUp(): Promise<void> {
    for (;;) {
      const caughtUp = await this.pollOnce();
      if (caughtUp) return;
    }
  }

  /** Start the polling loop; resumes using the persisted cursor after restart. */
  start(signal: AbortSignal): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      for (;;) {
        if (signal.aborted) {
          this.running = false;
          return;
        }
        try {
          await this.catchUp();
        } catch (err) {
          this.logger.error(`score feed failed: ${(err as Error).message}`);
        }
        await sleep(this.pollIntervalMs, signal);
      }
    })();
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
