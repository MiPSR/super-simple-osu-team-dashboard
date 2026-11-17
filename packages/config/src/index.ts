/**
 * The single configuration file: `data/config.toml` (relative to the working
 * directory). Both server processes read it. There are no environment
 * variables, no CLI flags and no defaults in code for the required keys — a
 * missing value is an explicit startup error (spec section 2).
 *
 * TOML is parsed natively by Bun. The SQLite database lives in the same data
 * directory as this file.
 */

/** Fixed location of the configuration file. */
export const CONFIG_PATH = "data/config.toml";

export interface AppConfig {
  teamId: number;
  clientId: string;
  clientSecret: string;
  /** osu! refresh token stored by the operator; rotated tokens are written back. */
  refreshToken: string;
  /** Optional: request budget = 60 / rateDivider per minute. Default 2. */
  rateDivider: number;
  /** Path the configuration was loaded from (the data directory anchor). */
  configPath: string;
}

/** The SQLite file sits beside the config file in the same data directory. */
export function databasePathFor(config: AppConfig): string {
  const dir = config.configPath.slice(0, config.configPath.lastIndexOf("/"));
  return `${dir}/team.sqlite`;
}

export class ConfigError extends Error {}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function requireInt(raw: Record<string, unknown>, key: string, configPath: string): number {
  const value = raw[key];
  if (value === undefined) {
    throw new ConfigError(`${configPath}: missing required value "${key}"`);
  }
  if (!isInteger(value)) {
    throw new ConfigError(`${configPath}: "${key}" must be an integer, got ${typeof value}`);
  }
  return value;
}

function requireString(raw: Record<string, unknown>, key: string, configPath: string): string {
  const value = raw[key];
  if (value === undefined) {
    throw new ConfigError(`${configPath}: missing required value "${key}"`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${configPath}: "${key}" must be a non-empty string`);
  }
  return value;
}

/** The osu! client ID is numeric; accept an integer or its decimal string form. */
function requireClientId(raw: Record<string, unknown>, key: string, configPath: string): string {
  const value = raw[key];
  if (value === undefined) {
    throw new ConfigError(`${configPath}: missing required value "${key}"`);
  }
  if (isInteger(value)) {
    if ((value as number) <= 0) {
      throw new ConfigError(`${configPath}: "${key}" must be a positive id, got ${value}`);
    }
    return String(value);
  }
  return requireString(raw, key, configPath);
}

/** Validate the parsed TOML object. Exported for tests. */
export function validateConfig(raw: Record<string, unknown>, configPath: string): AppConfig {
  const teamId = requireInt(raw, "team_id", configPath);
  if (teamId <= 0) {
    throw new ConfigError(`${configPath}: "team_id" must be a positive integer, got ${teamId}`);
  }

  const clientId = requireClientId(raw, "client_id", configPath);
  const clientSecret = requireString(raw, "client_secret", configPath);
  const refreshToken = requireString(raw, "refresh_token", configPath);

  const rateDividerRaw = raw["rate_divider"];
  if (rateDividerRaw !== undefined && !isInteger(rateDividerRaw)) {
    throw new ConfigError(`${configPath}: "rate_divider" must be an integer, got ${typeof rateDividerRaw}`);
  }
  const rateDivider = (rateDividerRaw as number | undefined) ?? 2;
  if (rateDivider < 1) {
    throw new ConfigError(`${configPath}: "rate_divider" must be an integer ≥ 1, got ${rateDivider}`);
  }

  return { teamId, clientId, clientSecret, refreshToken, rateDivider, configPath };
}

/**
 * Persist the rotated refresh token: the app replaces the `refresh_token`
 * value in the configuration file with the latest one returned by osu!.
 * Only the file value changes — nothing on osu!'s side.
 */
export async function writeRefreshToken(config: AppConfig, refreshToken: string): Promise<void> {
  const lines = [
    `team_id = ${config.teamId}`,
    `client_id = ${config.clientId}`,
    `client_secret = "${config.clientSecret}"`,
    `rate_divider = ${config.rateDivider}`,
    `refresh_token = "${refreshToken}"`,
    "",
  ];
  await Bun.write(config.configPath, lines.join("\n"));
}

/** Load and validate `data/config.toml` from the working directory. */
export async function loadConfig(): Promise<AppConfig> {
  const absolute = `${process.cwd()}/${CONFIG_PATH}`;
  let raw: Record<string, unknown>;
  try {
    const mod = (await import(absolute)) as { default?: Record<string, unknown> };
    raw = (mod.default ?? mod) as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new ConfigError(
      code === "ERR_MODULE_NOT_FOUND"
        ? `configuration file not found: ${CONFIG_PATH} (create it from config.example.toml in the working directory)`
        : `invalid configuration: ${CONFIG_PATH} — ${(err as Error).message}`,
    );
  }
  return validateConfig(raw, CONFIG_PATH);
}
