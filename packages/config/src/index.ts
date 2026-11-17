import { parse } from "smol-toml";

/**
 * Validated configuration shared by both server processes (spec section 2).
 *
 * - `team_id` is required (positive integer).
 * - `rate_divider` ≥ 1 (default 2): request budget is 60/divider per minute.
 * - `score_poll_base_seconds` > 0 (default 5): effective score-feed interval
 *   is base × divider (10 s by default).
 * - Missing required values prevent startup with an explicit error (2.6).
 *
 * Credentials come from the environment only (OSU_CLIENT_ID /
 * OSU_CLIENT_SECRET) — never from the TOML file.
 */

export interface AppConfig {
  teamId: number;
  rateDivider: number;
  scorePollBaseSeconds: number;
  databasePath: string;
  port: number;
  /** Path the configuration was loaded from (for diagnostics). */
  configPath: string;
}

export class ConfigError extends Error {}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function readOptionalInt(raw: Record<string, unknown>, key: string, errorPrefix: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isInteger(value)) {
    throw new ConfigError(`${errorPrefix}: "${key}" must be an integer, got ${typeof value}`);
  }
  return value;
}

export function loadConfigFromString(toml: string, configPath: string): AppConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parse(toml) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`${configPath}: invalid TOML — ${(err as Error).message}`);
  }

  const teamId = readOptionalInt(raw, "team_id", configPath);
  if (teamId === undefined) {
    throw new ConfigError(`${configPath}: missing required value "team_id"`);
  }
  if (teamId <= 0) {
    throw new ConfigError(`${configPath}: "team_id" must be a positive integer, got ${teamId}`);
  }

  const rateDivider = readOptionalInt(raw, "rate_divider", configPath) ?? 2;
  if (rateDivider < 1) {
    throw new ConfigError(`${configPath}: "rate_divider" must be an integer ≥ 1, got ${rateDivider}`);
  }

  const scorePollBaseSeconds = readOptionalInt(raw, "score_poll_base_seconds", configPath) ?? 5;
  if (scorePollBaseSeconds <= 0) {
    throw new ConfigError(
      `${configPath}: "score_poll_base_seconds" must be a positive integer, got ${scorePollBaseSeconds}`,
    );
  }

  const databasePath = raw["database_path"];
  if (databasePath !== undefined && typeof databasePath !== "string") {
    throw new ConfigError(`${configPath}: "database_path" must be a string`);
  }

  const port = readOptionalInt(raw, "port", configPath) ?? 3000;
  if (port <= 0 || port > 65535) {
    throw new ConfigError(`${configPath}: "port" must be an integer between 1 and 65535, got ${port}`);
  }

  return {
    teamId,
    rateDivider,
    scorePollBaseSeconds,
    databasePath: (databasePath as string | undefined) ?? "./data/team.sqlite",
    port,
    configPath,
  };
}

/** Resolve the config path from --config / TEAM_CONFIG / default "./team.toml". */
export function resolveConfigPath(argv: string[], env: Record<string, string | undefined>): string {
  const flagIndex = argv.indexOf("--config");
  if (flagIndex !== -1 && argv[flagIndex + 1] !== undefined) {
    return argv[flagIndex + 1] as string;
  }
  return env.TEAM_CONFIG ?? "./team.toml";
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await Bun.file(configPath).text();
  } catch {
    throw new ConfigError(
      `configuration file not found: ${configPath} (pass --config <path>, set TEAM_CONFIG, or create ./team.toml — see config.example.toml)`,
    );
  }
  return loadConfigFromString(text, configPath);
}

export interface OsuCredentials {
  clientId: string;
  clientSecret: string;
}

/** osu! OAuth2 client credentials from the environment (2.2). */
export function loadCredentials(env: Record<string, string | undefined>): OsuCredentials {
  const clientId = env.OSU_CLIENT_ID;
  const clientSecret = env.OSU_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConfigError(
      "missing required environment credentials: OSU_CLIENT_ID and OSU_CLIENT_SECRET must be set",
    );
  }
  return { clientId, clientSecret };
}
