import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, loadCredentials, resolveConfigPath } from "@osu-team/config";
import { openDatabase, migrate } from "@osu-team/database";
import { Queries } from "@osu-team/database";
import { Scheduler, systemClock } from "./scheduler.ts";
import { OsuClient } from "./osu.ts";
import { TeamRoster } from "./roster.ts";
import { ScoreFeed } from "./feed.ts";
import { HourlyCollector, startHourlyLoop } from "./hourly.ts";
import { BeatmapEnricher } from "./enrich.ts";
import type { Logger } from "./osu.ts";

/** Minimal structured logger; never emits OAuth credentials (8.5). */
function createLogger(): Logger {
  return {
    info: (m) => console.log(`[collector] ${m}`),
    warn: (m) => console.warn(`[collector] WARN ${m}`),
    error: (m) => console.error(`[collector] ERROR ${m}`),
  };
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const logger = createLogger();

  // Validate configuration (8.6) — a missing value aborts startup with an
  // explicit error (2.6).
  const configPath = resolveConfigPath(argv, env);
  const config = await loadConfig(configPath);
  const credentials = loadCredentials(env);
  logger.info(
    `config ok: team_id=${config.teamId} rate_divider=${config.rateDivider} poll=${config.scorePollBaseSeconds}s (effective ${config.scorePollBaseSeconds * config.rateDivider}s) db=${config.databasePath}`,
  );

  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = openDatabase({ path: config.databasePath });
  migrate(db);
  const queries = new Queries(db);

  const scheduler = new Scheduler(config.rateDivider, systemClock, (event) => {
    if (event.type === "retry") logger.warn(`scheduler retry (attempt ${event.attempt}) after ${event.backoffMs} ms`);
    if (event.type === "auth-retry") logger.warn(`auth retry ${event.count}`);
    if (event.type === "permanent-failure") logger.error(`request permanently failed: ${event.detail}`);
    if (event.type === "budget-wait") logger.info(`rate budget reached; waiting ${event.waitMs} ms`);
  });

  const client = new OsuClient({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    scheduler,
    logger,
  });

  const roster = new TeamRoster(client, queries, config.teamId, logger);
  roster.loadFromDatabase();

  // Team sync with limited retries at startup (8.6).
  let synced = false;
  for (let attempt = 1; attempt <= 3 && !synced; attempt++) {
    try {
      await roster.sync();
      synced = true;
    } catch (err) {
      logger.error(`startup team sync attempt ${attempt} failed: ${(err as Error).message}`);
      if (attempt === 3) {
        console.error("[collector] FATAL could not synchronize the team; exiting");
        process.exit(1);
      }
      await systemClock.sleep(2_000 * attempt);
    }
  }

  const feed = new ScoreFeed(
    client,
    queries,
    roster,
    config.scorePollBaseSeconds,
    config.rateDivider,
    logger,
  );

  const abort = new AbortController();
  const signal = abort.signal;

  // Initialize the score feed and keep polling (8.6, 3.4).
  try {
    await feed.catchUp();
  } catch (err) {
    logger.error(`initial score feed pass failed: ${(err as Error).message}`);
  }
  feed.start(signal);

  // First profile collection immediately, then every UTC hour (8.6, 2.5).
  const hourly = new HourlyCollector(client, queries, roster, logger);
  await hourly.collect(Date.now());
  startHourlyLoop(hourly, signal);

  const enricher = new BeatmapEnricher(client, queries, logger);
  enricher.start(signal);

  const shutdown = () => {
    logger.info("shutting down");
    abort.abort();
    queries.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("collector started");
}

if (import.meta.main) {
  await main(Bun.argv.slice(2), process.env as Record<string, string | undefined>);
}
