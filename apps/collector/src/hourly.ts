import type { Queries, SnapshotInput } from "@osu-team/database";
import { nowIso, logicalHourOf } from "@osu-team/database";
import type { OsuClient, Logger } from "./osu.ts";
import { userToSnapshots } from "./mapping.ts";
import type { TeamRoster } from "./roster.ts";

/** Max user IDs per GET /users request, per osu! api wiki (3.7). */
export const USERS_CHUNK_SIZE = 50;

/**
 * Hourly profile collection (spec 3.7 – 3.10):
 * - at each UTC hour: synchronize membership, then fetch all current members
 *   in chunks of ≤ 50 IDs;
 * - each member's available statistics for all four game modes are staged;
 * - the completed collection is published atomically in one transaction — no
 *   partial snapshots on failure;
 * - one logical collection per UTC hour; a collection exceeding the next hour
 *   completes or fails before another begins, and skipped hours are recorded.
 */
export class HourlyCollector {
  private running = false;
  private lastAttemptedHour: number | null = null;

  constructor(
    private readonly client: OsuClient,
    private readonly queries: Queries,
    private readonly roster: TeamRoster,
    private readonly logger: Logger,
    private readonly nowFn: () => string = nowIso,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Run the collection for the UTC hour containing `nowMs`. */
  async collect(nowMs: number): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    const logicalHour = logicalHourOf(nowMs);
    this.lastAttemptedHour = logicalHour;
    try {
      return await this.collectHour(logicalHour);
    } finally {
      this.running = false;
    }
  }

  private async collectHour(logicalHour: number): Promise<number | null> {
    const startedAtIso = this.nowFn();
    // Team sync first so the roster used for filtering and snapshots is fresh (3.1).
    try {
      await this.roster.sync();
    } catch (err) {
      this.logger.error(`hourly collection (hour ${logicalHour}) aborted: team sync failed — ${(err as Error).message}`);
      return null;
    }

    const memberIds = this.roster.ids();
    const collectionId = this.queries.startCollection(logicalHour, memberIds.length, startedAtIso);
    this.logger.info(`hourly collection ${collectionId} started for logical hour ${logicalHour} (roster ${memberIds.length})`);

    const staged: SnapshotInput[] = [];
    let failure: string | null = null;

    const chunks = chunk(memberIds, USERS_CHUNK_SIZE);
    for (let index = 0; index < chunks.length; index++) {
      const chunkIds = chunks[index] as number[];
      try {
        const users = await this.client.getUsers(chunkIds);
        const gatheredAt = this.nowFn();
        for (const user of users) {
          staged.push(...userToSnapshots(user, collectionId, gatheredAt));
        }
        // Detect users silently missing from the response (incomplete data).
        const returned = new Set(users.map((u) => u.id));
        const missing = chunkIds.filter((id) => !returned.has(id));
        if (missing.length > 0) {
          failure = `users endpoint omitted ${missing.length} of ${chunkIds.length} requested members (chunk ${index + 1}/${chunks.length})`;
        }
      } catch (err) {
        failure = `users request failed (chunk ${index + 1}/${chunks.length}, ${chunkIds.length} ids): ${(err as Error).message}`;
        break;
      }
    }

    if (failure !== null || staged.length === 0) {
      const error = failure ?? "no snapshots retrieved";
      this.queries.failCollection(collectionId, this.nowFn(), error);
      this.logger.error(`hourly collection ${collectionId} FAILED for logical hour ${logicalHour}: ${error}`);
      return null;
    }

    // Atomic publish: stage-then-commit, no partial snapshots (3.9).
    try {
      this.queries.publishHourlyCollection({
        collectionId,
        snapshots: staged,
        finishedAtIso: this.nowFn(),
      });
      this.logger.info(`hourly collection ${collectionId} published for logical hour ${logicalHour} (${staged.length} snapshots)`);
      return collectionId;
    } catch (err) {
      const error = (err as Error).message;
      this.queries.failCollection(collectionId, this.nowFn(), error);
      this.logger.error(`hourly collection ${collectionId} FAILED to publish for logical hour ${logicalHour}: ${error}`);
      return null;
    }
  }

  /** Record logical hours skipped while a previous collection was still running (3.10). */
  recordMissedHours(nowMs: number): void {
    if (this.lastAttemptedHour === null) return;
    const currentHour = logicalHourOf(nowMs);
    for (let hour = this.lastAttemptedHour + 3_600; hour < currentHour; hour += 3_600) {
      this.queries.markMissedHour(hour, this.nowFn(), "skipped: previous collection still running");
      this.logger.warn(`recorded missed logical hour ${hour}`);
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Hourly loop: fire at each UTC hour boundary. A collection that overruns the
 * next boundary completes or fails first; missed hours are recorded.
 */
export function startHourlyLoop(
  collector: HourlyCollector,
  signal: AbortSignal,
  clock: { now(): number; sleep(ms: number): Promise<void> } = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
): void {
  void (async () => {
    for (;;) {
      if (signal.aborted) return;
      const now = clock.now();
      const nextHour = (Math.floor(now / 3_600_000) + 1) * 3_600_000;
      await clock.sleep(nextHour - now);
      if (signal.aborted) return;
      try {
        if (collector.isRunning) {
          collector.recordMissedHours(clock.now());
          continue;
        }
        await collector.collect(clock.now());
      } catch (err) {
        console.error(`hourly loop error: ${(err as Error).message}`);
      }
    }
  })();
}
