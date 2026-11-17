import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { openDatabase } from "@osu-team/database";
import type { Database as SqliteDatabase } from "bun:sqlite";

/**
 * End-to-end wiring check (8.6): run the real collector main() against a mock
 * osu! backend (via the OSU_API_BASE test override) and verify the whole
 * pipeline: config → migrations → team sync → feed init → first hourly
 * collection → published snapshots.
 */

const PORT = 42091;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_URL = `${BASE}/oauth/token`;
const WORK = `${import.meta.dir}/.e2e-work`;

const TEAM = {
  id: 55,
  name: "e2e team",
  short_name: "E2E",
  flag_url: "https://assets.ppy.sh/flag.png",
  cover_url: null,
  default_ruleset_id: 2, // fruits default
  leader: { id: 10, username: "captain", avatar_url: null, country_code: "AU" },
  members: [{ id: 11, username: "rookie", avatar_url: null, country_code: "DE" }],
};

function user(id: number) {
  return {
    id,
    username: id === 10 ? "captain" : "rookie",
    avatar_url: null,
    country_code: "AU",
    statistics_rulesets: {
      osu: null,
      taiko: null,
      fruits: {
        pp: 777,
        global_rank: 42,
        country_rank: 2,
        accuracy: 0.98,
        maximum_combo: 300,
        ranked_score: 500000,
        total_score: 800000,
        total_hits: 120000,
        play_count: 3000,
        play_time: 200000,
        replays_watched_by_others: 1,
        level: { current: 90, progress: 10 },
        grade_counts: { a: 500, s: 100, sh: 10, ss: 5, ssh: 1 },
        count_300: 90000,
        count_100: 8000,
        count_50: 700,
        count_miss: 600,
      },
      mania: null,
    },
  };
}

let tokenIssued = 0;
let cursorHead = "cursor-head-1";

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/oauth/token") {
      tokenIssued += 1;
      return Response.json({ access_token: `tok-${tokenIssued}`, token_type: "Bearer", expires_in: 86400 });
    }
    const auth = request.headers.get("Authorization");
    if (auth !== "Bearer tok-1") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/api/v2/teams/55") {
      return Response.json(TEAM);
    }
    if (url.pathname === "/api/v2/scores") {
      // First call: latest batch with one team member score and one stranger.
      return Response.json({
        scores: [
          {
            id: 9001,
            user_id: 11,
            beatmap_id: 321,
            ruleset_id: 2,
            ended_at: "2026-01-01T09:00:00.000Z",
            started_at: null,
            passed: true,
            pp: 123.4,
            accuracy: 0.99,
            total_score: 700000,
            classic_total_score: 650000,
            legacy_total_score: null,
            legacy_score_id: null,
            type: "score_best",
            rank: "A",
            max_combo: 250,
            is_perfect_combo: false,
            legacy_perfect: false,
            mods: [{ acronym: "HR" }],
            statistics: { great: 900, ok: 50, meh: 5, miss: 3 },
            beatmap: { id: 321, beatmapset_id: 654, difficulty_rating: 5.5, total_length: 150, status: "ranked", version: "Extra" },
            beatmapset: { id: 654, title: "e2e song", artist: "e2e artist", covers: { cover: "https://assets.ppy.sh/cover.jpg" } },
          },
          { id: 9002, user_id: 999, beatmap_id: 322, ruleset_id: 0, ended_at: "2026-01-01T09:00:01.000Z", passed: true, pp: null, accuracy: 0.5, total_score: 1, rank: "D", max_combo: 1, mods: [], statistics: {}, type: "score_best" },
        ],
        cursor_string: cursorHead,
      });
    }
    if (url.pathname === "/api/v2/users") {
      const ids = (url.searchParams.getAll("ids[]")).map(Number);
      return Response.json({ users: ids.map(user) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
  rmSync(WORK, { recursive: true, force: true });
});

describe("collector end-to-end (8.6)", () => {
  test("runs the full startup pipeline against a mock osu! backend", async () => {
    mkdirSync(WORK, { recursive: true });
    const dbPath = `${WORK}/team.sqlite`;
    const configPath = `${WORK}/team.toml`;
    await Bun.write(configPath, `team_id = 55\ndatabase_path = "${dbPath}"\nrate_divider = 1\n`);

    const proc = Bun.spawn({
      cmd: ["bun", "run", "apps/collector/src/main.ts", "--config", configPath],
      env: {
        ...process.env,
        OSU_CLIENT_ID: "e2e-client",
        OSU_CLIENT_SECRET: "e2e-secret",
        OSU_API_BASE: `${BASE}/api/v2`,
        OSU_TOKEN_URL: TOKEN_URL,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait until the first hourly collection is published (max ~15 s).
    let db: SqliteDatabase | null = null;
    let published = false;
    for (let i = 0; i < 150; i++) {
      await Bun.sleep(100);
      try {
        if (!db) db = openDatabase({ path: dbPath });
        const row = db.query("SELECT COUNT(*) AS n FROM collections WHERE status = 'published'").get() as { n: number };
        if (row.n > 0) {
          published = true;
          break;
        }
      } catch {
        /* schema not ready yet */
      }
    }

    proc.kill();
    await proc.exited;

    expect(published).toBe(true);
    const check = openDatabase({ path: dbPath, readonly: true });

    // Team identity from the API, including the default mode (2.1, 4.1).
    const team = check.query("SELECT id, name, short_name, flag_url, default_mode FROM team").get() as Record<string, string | number>;
    expect(team.id).toBe(55);
    expect(team.name).toBe("e2e team");
    expect(team.default_mode).toBe("fruits");

    // Roster synced: leader + member, active (4.2).
    const members = check.query("SELECT user_id, status FROM members ORDER BY user_id").all() as Array<Record<string, string | number>>;
    expect(members).toEqual([
      { user_id: 10, status: "active" },
      { user_id: 11, status: "active" },
    ]);

    // Feed initialized with the persisted cursor (3.3); only the team score retained (3.2).
    const state = check.query("SELECT cursor_string FROM collector_state").get() as { cursor_string: string };
    expect(state.cursor_string).toBe("cursor-head-1");
    const scores = check.query("SELECT id, player_id FROM scores").all() as Array<Record<string, number>>;
    expect(scores).toEqual([{ id: 9001, player_id: 11 }]);
    const beatmap = check.query("SELECT title, difficulty_name FROM beatmaps").get() as Record<string, string>;
    expect(beatmap.title).toBe("e2e song");
    expect(beatmap.difficulty_name).toBe("Extra");

    // First profile collection published with one snapshot per member per mode (3.7).
    const snapshots = check.query("SELECT user_id, mode, pp, global_rank FROM profile_snapshots WHERE pp IS NOT NULL ORDER BY user_id").all() as Array<Record<string, string | number>>;
    expect(snapshots).toEqual([
      { user_id: 10, mode: "fruits", pp: 777, global_rank: 42 },
      { user_id: 11, mode: "fruits", pp: 777, global_rank: 42 },
    ]);
    const total = check.query("SELECT COUNT(*) AS n FROM profile_snapshots").get() as { n: number };
    expect(total.n).toBe(8); // 2 members × 4 modes

    // Logs never expose OAuth credentials (8.5).
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const logs = stdout + stderr;
    expect(logs).not.toContain("e2e-secret");
    expect(logs).toContain("published for logical hour");

    check.close();
  }, 30000);
});
