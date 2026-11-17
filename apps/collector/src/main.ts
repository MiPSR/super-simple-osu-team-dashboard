import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, databasePathFor, writeRefreshToken } from "@osu-team/config";
import { openDatabase, migrate } from "@osu-team/database";
import { Queries } from "@osu-team/database";
import { Scheduler, systemClock } from "./scheduler.ts";
import { OsuClient } from "./osu.ts";
import { RefreshTokenManager } from "./token.ts";
import { TeamRoster } from "./roster.ts";
import { ScoreFeed } from "./feed.ts";
import { HourlyCollector, startHourlyLoop } from "./hourly.ts";
import { BeatmapEnricher } from "./enrich.ts";
import type { Logger } from "./osu.ts";

/** Minimal structured logger; never emits credentials (8.5). */
function createLogger(): Logger {
  return {
    info: (m) => console.log(`[collector] ${m}`),
    warn: (m) => console.warn(`[collector] WARN ${m}`),
    error: (m) => console.error(`[collector] ERROR ${m}`),
  };
}

export interface CollectorOptions {
  /** Test-only override for mock backends; production uses the official endpoints. */
  apiBase?: string;
  tokenUrl?: string;
}

export async function main(options: CollectorOptions = {}): Promise<void> {
  const logger = createLogger();

  // The single configuration file: data/config.toml (2.6). A missing required
  // value aborts startup with an explicit error.
  const config = await loadConfig();
  const databasePath = databasePathFor(config);
  logger.info(
    `config ok: team_id=${config.teamId} rate_divider=${config.rateDivider} db=${databasePath}`,
  );

  mkdirSync(dirname(databasePath), { recursive: true });
  const db = openDatabase({ path: databasePath });
  migrate(db);
  const queries = new Queries(db);

  const scheduler = new Scheduler(config.rateDivider, systemClock, (event) => {
    if (event.type === "retry") logger.warn(`scheduler retry (attempt ${event.attempt}) after ${event.backoffMs} ms`);
    if (event.type === "permanent-failure") logger.error(`request permanently failed: ${event.detail}`);
    if (event.type === "budget-wait") logger.info(`rate budget reached; waiting ${event.waitMs} ms`);
  });

  // osu! token handling (2.2): the refresh token comes from the configuration
  // file; rotated tokens are written back. A rejected token exits the process.
  const tokenManager = new RefreshTokenManager({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
    tokenUrl: options.tokenUrl,
    clock: systemClock,
    onRotate: (refreshToken) => writeRefreshToken(config, refreshToken),
    onDead: (reason) => {
      logger.error(`FATAL ${reason}`);
      process.exit(1);
    },
    logger,
  });

  const client = new OsuClient({
    scheduler,
    logger,
    apiBase: options.apiBase,
    tokenProvider: tokenManager,
  });

  const roster = new TeamRoster(client, queries, config.teamId, logger);
  roster.loadFromDatabase();

  // Team synchronization (3.1): one attempt at startup through the shared
  // scheduler; API-level backoff applies. The hourly loop retries at the next
  // UTC hour — an API failure never exits the process.
  try {
    await roster.sync();
  } catch (err) {
    logger.error(`startup team sync failed: ${(err as Error).message}`);
  }

  const feed = new ScoreFeed(client, queries, roster, config.rateDivider, logger);

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
  await main();
}
