import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, databasePathFor, loadConfig, CONFIG_PATH, ConfigError } from "../src/index.ts";

const P = "data/config.toml";

/** Write a TOML file into a fresh temp dir and validate it (Bun parses TOML natively). */
async function loadTemp(toml: string): Promise<ReturnType<typeof validateConfig>> {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const file = join(dir, "config.toml");
  writeFileSync(file, toml);
  const mod = (await import(file)) as { default?: Record<string, unknown> };
  return validateConfig((mod.default ?? mod) as Record<string, unknown>, P);
}

describe("config loading (spec section 2)", () => {
  test("parses the three required values; rate_divider defaults to 2", async () => {
    const config = await loadTemp("team_id = 123\nclient_id = 999\nclient_secret = \"abc\"\n");
    expect(config.teamId).toBe(123);
    expect(config.clientId).toBe("999");
    expect(config.clientSecret).toBe("abc");
    expect(config.rateDivider).toBe(2);
    expect(config.configPath).toBe(P);
  });

  test("optional rate_divider is honored", async () => {
    expect((await loadTemp("team_id = 1\nclient_id = 1\nclient_secret = \"s\"\nrate_divider = 3\n")).rateDivider).toBe(3);
  });

  test.each(["team_id", "client_id", "client_secret"])("missing %s prevents startup with an explicit error", async (key) => {
    const lines = ["team_id = 123", "client_id = 999", 'client_secret = "abc"'];
    const text = lines.filter((l) => !l.startsWith(key)).join("\n") + "\n";
    expect(async () => await loadTemp(text)).toThrow(new RegExp(`missing required value "${key}"`));
  });

  test("team_id must be a positive integer", async () => {
    expect(async () => await loadTemp("team_id = 0\nclient_id = 1\nclient_secret = \"s\"\n")).toThrow(ConfigError);
    expect(async () => await loadTemp("team_id = -1\nclient_id = 1\nclient_secret = \"s\"\n")).toThrow(ConfigError);
    expect(async () => await loadTemp("team_id = \"x\"\nclient_id = 1\nclient_secret = \"s\"\n")).toThrow(/integer/);
  });

  test("secrets must be non-empty strings", async () => {
    expect(async () => await loadTemp("team_id = 1\nclient_id = 1\nclient_secret = \"\"\n")).toThrow(/client_secret/);
    expect(async () => await loadTemp("team_id = 1\nclient_id = 1\nclient_secret = 5\n")).toThrow(/client_secret/);
  });

  test("rate_divider must be an integer ≥ 1", async () => {
    expect(async () => await loadTemp("team_id = 1\nclient_id = 1\nclient_secret = \"s\"\nrate_divider = 0\n")).toThrow(ConfigError);
    expect(async () => await loadTemp("team_id = 1\nclient_id = 1\nclient_secret = \"s\"\nrate_divider = 1.5\n")).toThrow(ConfigError);
  });

  test("there is no port or database path key — unknown keys are not configuration", async () => {
    const config = await loadTemp("team_id = 1\nclient_id = 1\nclient_secret = \"s\"\nport = 8080\ndatabase_path = \"/tmp/x\"\n");
    expect((config as unknown as Record<string, unknown>).port).toBeUndefined();
    expect((config as unknown as Record<string, unknown>).database_path).toBeUndefined();
  });

  test("invalid TOML reports the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const file = join(dir, "config.toml");
    writeFileSync(file, "team_id = = 1");
    expect(async () => await import(file)).toThrow();
  });

  test("the SQLite file lives in the same data directory as the config", async () => {
    const config = validateConfig({ team_id: 1, client_id: "a", client_secret: "b" }, "data/config.toml");
    expect(databasePathFor(config)).toBe("data/team.sqlite");
    const nested = validateConfig({ team_id: 1, client_id: "a", client_secret: "b" }, "/var/lib/osu-dash/data/config.toml");
    expect(databasePathFor(nested)).toBe("/var/lib/osu-dash/data/team.sqlite");
  });

  test("the fixed config path is data/config.toml — no flags, no env, no override", () => {
    expect(CONFIG_PATH).toBe("data/config.toml");
  });

  test("a missing file prevents startup with an explicit error", async () => {
    const cwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "nocfg-")));
    try {
      await expect(loadConfig()).rejects.toThrow(/configuration file not found: data\/config\.toml/);
    } finally {
      process.chdir(cwd);
    }
  });

  test("loadConfig reads the file from the working directory", async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "read-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data/config.toml"), "team_id = 42\nclient_id = 7\nclient_secret = \"s\"\n");
    process.chdir(dir);
    try {
      const config = await loadConfig();
      expect(config.teamId).toBe(42);
      expect(databasePathFor(config)).toBe("data/team.sqlite");
    } finally {
      process.chdir(cwd);
    }
  });
});
