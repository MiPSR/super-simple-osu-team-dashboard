import { describe, test, expect } from "bun:test";
import { loadConfigFromString, loadCredentials, resolveConfigPath, ConfigError } from "../src/index.ts";

describe("config loading (spec section 2)", () => {
  test("parses a minimal configuration with team_id only", () => {
    const config = loadConfigFromString("team_id = 123\n", "team.toml");
    expect(config.teamId).toBe(123);
    expect(config.rateDivider).toBe(2);
    expect(config.scorePollBaseSeconds).toBe(5);
    expect(config.databasePath).toBe("./data/team.sqlite");
    expect(config.port).toBe(3000);
  });

  test("parses every optional value", () => {
    const toml = `
      team_id = 7
      rate_divider = 3
      score_poll_base_seconds = 10
      database_path = "/tmp/x.sqlite"
      port = 8080
    `;
    const config = loadConfigFromString(toml, "team.toml");
    expect(config.rateDivider).toBe(3);
    expect(config.scorePollBaseSeconds).toBe(10);
    expect(config.databasePath).toBe("/tmp/x.sqlite");
    expect(config.port).toBe(8080);
  });

  test("rejects a missing team_id with an explicit error (2.6)", () => {
    expect(() => loadConfigFromString("rate_divider = 2\n", "team.toml")).toThrow(ConfigError);
  });

  test("rejects a non-positive team_id (2.1)", () => {
    expect(() => loadConfigFromString("team_id = 0\n", "team.toml")).toThrow(ConfigError);
    expect(() => loadConfigFromString("team_id = -1\n", "team.toml")).toThrow(ConfigError);
  });

  test("rejects a non-integer team_id", () => {
    expect(() => loadConfigFromString('team_id = "abc"\n', "team.toml")).toThrow(ConfigError);
  });

  test("rate_divider must be an integer >= 1 (2.3)", () => {
    expect(() => loadConfigFromString("team_id = 1\nrate_divider = 0\n", "t")).toThrow(ConfigError);
    expect(() => loadConfigFromString("team_id = 1\nrate_divider = 1.5\n", "t")).toThrow(ConfigError);
  });

  test("score_poll_base_seconds must be a positive integer (2.4)", () => {
    expect(() => loadConfigFromString("team_id = 1\nscore_poll_base_seconds = 0\n", "t")).toThrow(ConfigError);
    expect(() => loadConfigFromString("team_id = 1\nscore_poll_base_seconds = -5\n", "t")).toThrow(ConfigError);
  });

  test("invalid TOML reports the file", () => {
    expect(() => loadConfigFromString("team_id = = 1", "broken.toml")).toThrow(/broken\.toml/);
  });

  test("credentials come from the environment only (2.2)", () => {
    expect(() => loadCredentials({})).toThrow(/OSU_CLIENT_ID/);
    expect(() => loadCredentials({ OSU_CLIENT_ID: "1" })).toThrow(/OSU_CLIENT_SECRET/);
    const creds = loadCredentials({ OSU_CLIENT_ID: "1", OSU_CLIENT_SECRET: "s" });
    expect(creds).toEqual({ clientId: "1", clientSecret: "s" });
  });

  test("config path resolution: --config flag wins over TEAM_CONFIG", () => {
    expect(resolveConfigPath(["--config", "/a/b.toml"], { TEAM_CONFIG: "/c/d.toml" })).toBe("/a/b.toml");
    expect(resolveConfigPath([], { TEAM_CONFIG: "/c/d.toml" })).toBe("/c/d.toml");
    expect(resolveConfigPath([], {})).toBe("./team.toml");
  });
});
