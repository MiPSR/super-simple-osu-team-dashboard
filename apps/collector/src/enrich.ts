import type { Queries } from "@osu-team/database";
import { nowIso } from "@osu-team/database";
import type { OsuClient, Logger } from "./osu.ts";
import { beatmapToInput } from "./mapping.ts";

/** Batch size of queued beatmap lookups per enrichment pass (3.11). */
const ENRICH_BATCH = 25;

/**
 * Beatmap enrichment (spec 3.11): store metadata supplied with matching
 * scores, then fill gaps via lower-priority queued GET /beatmaps/{id}
 * requests, cached by beatmap ID to avoid repeated lookups.
 */
export class BeatmapEnricher {
  constructor(
    private readonly client: OsuClient,
    private readonly queries: Queries,
    private readonly logger: Logger,
  ) {}

  /** One pass; returns the number of beatmaps enriched. */
  async enrichOnce(): Promise<number> {
    const missing = this.queries.getMissingBeatmapIds(ENRICH_BATCH);
    let count = 0;
    for (const id of missing) {
      try {
        const beatmap = await this.client.getBeatmap(id);
        this.queries.upsertBeatmaps([beatmapToInput(beatmap, beatmap.beatmapset ?? null)]);
        count += 1;
      } catch (err) {
        this.logger.warn(`beatmap lookup ${id} failed: ${(err as Error).message}`);
      }
    }
    if (count > 0) this.logger.info(`enriched ${count} beatmaps (${missing.length} missing)`);
    return count;
  }

  /** Periodic enrichment loop; runs between feed requests via the scheduler. */
  start(signal: AbortSignal, intervalMs = 60_000): void {
    void (async () => {
      for (;;) {
        if (signal.aborted) return;
        try {
          await this.enrichOnce();
        } catch (err) {
          this.logger.error(`beatmap enrichment failed: ${(err as Error).message}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    })();
  }
}
