import type { Database as SqliteDatabase, Statement, SQLQueryBindings } from "bun:sqlite";
import type { GameMode, LiveSortKey, MetricKey } from "@osu-team/contracts";
import { LIVE_SORTS, METRICS } from "@osu-team/contracts";
import { parseStoredInt, toApiNumber } from "@osu-team/contracts";
import { nowIso } from "./db.ts";

/** Integers beyond the JS safe range are read back as TEXT and parsed to bigint (4.5). */
export type StoredInt = number | bigint;

/**
 * Bind an integer that may exceed JavaScript's safe range: values beyond
 * 2^53 are written through `CAST(? AS INTEGER)` with their exact decimal
 * string so no precision is lost in SQLite's 64-bit column (4.5).
 */
function intBind(value: StoredInt | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export interface TeamRow {
  id: number;
  name: string;
  shortName: string;
  flagUrl: string | null;
  coverUrl: string | null;
  defaultMode: GameMode;
  syncedAt: string;
}

export interface MemberRow {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
  status: "active" | "former";
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface UpsertMemberInput {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
}

export interface SnapshotInput {
  collectionId: number;
  userId: number;
  mode: GameMode;
  gatheredAt: string;
  pp: number | null;
  globalRank: number | null;
  countryRank: number | null;
  accuracy: number | null;
  maxCombo: number | null;
  rankedScore: StoredInt | null;
  totalScore: StoredInt | null;
  totalHits: StoredInt | null;
  playCount: StoredInt | null;
  playTime: number | null;
  replayViews: StoredInt | null;
  level: number | null;
  levelProgress: number | null;
  gradeSs: StoredInt | null;
  gradeSsh: StoredInt | null;
  gradeS: StoredInt | null;
  gradeSh: StoredInt | null;
  gradeA: StoredInt | null;
  count300: StoredInt | null;
  count100: StoredInt | null;
  count50: StoredInt | null;
  countMiss: StoredInt | null;
}

export interface ScoreInput {
  id: number;
  playerId: number;
  beatmapId: number;
  mode: GameMode;
  endedAt: string;
  startedAt: string | null;
  pp: number | null;
  accuracy: number | null;
  totalScore: StoredInt | null;
  classicTotalScore: StoredInt | null;
  legacyTotalScore: StoredInt | null;
  legacyScoreId: number | null;
  scoreType: string | null;
  grade: string;
  combo: number | null;
  perfectCombo: boolean;
  mods: string;
  hasReplay: boolean;
  count300: StoredInt | null;
  count100: StoredInt | null;
  count50: StoredInt | null;
  countGeki: StoredInt | null;
  countKatu: StoredInt | null;
  countMiss: StoredInt | null;
  capturedAt: string;
}

export interface BeatmapInput {
  id: number;
  beatmapsetId: number;
  title: string | null;
  artist: string | null;
  difficultyName: string | null;
  starRating: number | null;
  lengthSeconds: number | null;
  status: string | null;
  coverUrl: string | null;
}

export interface LivePlay {
  scoreId: number;
  userId: number;
  username: string;
  avatarUrl: string | null;
  beatmapId: number;
  beatmapTitle: string | null;
  beatmapArtist: string | null;
  difficultyName: string | null;
  starRating: number | null;
  coverUrl: string | null;
  grade: string;
  mods: string;
  pp: number | null;
  accuracy: number | null;
  score: number | string | null; // JSON-safe via toApiNumber (big ints as strings)
  maxCombo: number | null;
  endedAt: string;
}

export interface LiveLeaderboardRow {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
  gatheredAt: string | null;
  values: Record<string, number | string | null>;
}

export interface CollectionRef {
  id: number;
  logicalHour: number;
}

/** Column names safe for interpolation (whitelist, never user input). */
const SNAPSHOT_COLUMNS = new Set<string>(
  Object.values(METRICS)
    .map((m) => m.column)
    .concat(
      Object.values(LIVE_SORTS).map((s) => s.column),
      ["gathered_at", "count_miss"],
    ),
);

function assertColumn(column: string): string {
  if (!SNAPSHOT_COLUMNS.has(column)) throw new Error(`unsafe column: ${column}`);
  return column;
}

export class Queries {
  private cache = new Map<string, Statement<any, any[]>>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly stateKey: string = "collector_state",
  ) {}

  private stmt<Row, Params extends SQLQueryBindings[] = any[]>(sql: string): Statement<Row, Params> {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql) as unknown as Statement<Row, Params>;
      this.cache.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- team (4.1)

  upsertTeam(team: TeamRow): void {
    this.stmt(
      `INSERT INTO team (id, name, short_name, flag_url, cover_url, default_mode, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, short_name = excluded.short_name, flag_url = excluded.flag_url,
         cover_url = excluded.cover_url, default_mode = excluded.default_mode, synced_at = excluded.synced_at`,
    ).run(team.id, team.name, team.shortName, team.flagUrl, team.coverUrl, team.defaultMode, team.syncedAt);
  }

  getTeam(): TeamRow | null {
    const row = this.stmt<
      {
        id: number;
        name: string;
        short_name: string;
        flag_url: string | null;
        cover_url: string | null;
        default_mode: string;
        synced_at: string;
      },
      []
    >("SELECT * FROM team LIMIT 1").get();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      shortName: row.short_name,
      flagUrl: row.flag_url,
      coverUrl: row.cover_url,
      defaultMode: row.default_mode as GameMode,
      syncedAt: row.synced_at,
    };
  }

  // ------------------------------------------------------------- members (4.2)

  upsertMembers(members: UpsertMemberInput[], atIso: string): void {
    const run = this.db.transaction(() => {
      for (const m of members) {
        this.stmt(
          `INSERT INTO members (user_id, username, avatar_url, country_code, status, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             username = excluded.username, avatar_url = excluded.avatar_url,
             country_code = excluded.country_code, status = 'active', last_seen_at = excluded.last_seen_at`,
        ).run(m.userId, m.username, m.avatarUrl, m.countryCode, atIso, atIso);
      }
    });
    run();
  }

  /** Players no longer in the team cease receiving snapshots (3.12). */
  deactivateAbsentMembers(activeUserIds: number[]): void {
    if (activeUserIds.length === 0) {
      this.stmt("UPDATE members SET status = 'former' WHERE status = 'active'").run();
      return;
    }
    const placeholders = activeUserIds.map(() => "?").join(", ");
    this.stmt(
      `UPDATE members SET status = 'former'
       WHERE status = 'active' AND user_id NOT IN (${placeholders})`,
    ).run(...activeUserIds);
  }

  getMember(userId: number): MemberRow | null {
    const row = this.stmt<
      { user_id: number; username: string; avatar_url: string | null; country_code: string | null; status: string; first_seen_at: string; last_seen_at: string },
      [number]
    >(
      "SELECT user_id, username, avatar_url, country_code, status, first_seen_at, last_seen_at FROM members WHERE user_id = ?",
    ).get(userId);
    if (!row) return null;
    return {
      userId: row.user_id,
      username: row.username,
      avatarUrl: row.avatar_url,
      countryCode: row.country_code,
      status: row.status as MemberRow["status"],
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  getActiveMemberIds(): number[] {
    return this.stmt<{ user_id: number }, []>("SELECT user_id FROM members WHERE status = 'active'").all().map((r) => r.user_id);
  }

  getActiveMembers(): MemberRow[] {
    return this.stmt<
      { user_id: number; username: string; avatar_url: string | null; country_code: string | null; status: string; first_seen_at: string; last_seen_at: string },
      []
    >(
      "SELECT user_id, username, avatar_url, country_code, status, first_seen_at, last_seen_at FROM members WHERE status = 'active' ORDER BY username",
    ).all().map((row) => ({
      userId: row.user_id,
      username: row.username,
      avatarUrl: row.avatar_url,
      countryCode: row.country_code,
      status: row.status as MemberRow["status"],
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  countActiveMembers(): number {
    return (this.stmt<{ n: number }, []>("SELECT COUNT(*) AS n FROM members WHERE status = 'active'").get() as { n: number }).n;
  }

  // --------------------------------------------------------- collections (4.3)

  startCollection(logicalHour: number, rosterSize: number, startedAtIso: string): number {
    const res = this.stmt(
      "INSERT INTO collections (logical_hour, attempt_started_at, roster_size, status) VALUES (?, ?, ?, 'running')",
    ).run(logicalHour, startedAtIso, rosterSize);
    return Number(res.lastInsertRowid);
  }

  publishCollection(id: number, finishedAtIso: string): void {
    this.stmt(
      `UPDATE collections SET status = 'published', attempt_finished_at = ?,
        error = NULL, roster_size = (SELECT COUNT(DISTINCT user_id) FROM profile_snapshots WHERE collection_id = collections.id)
       WHERE id = ? AND status = 'running'`,
    ).run(finishedAtIso, id);
  }

  failCollection(id: number, finishedAtIso: string, error: string): void {
    this.stmt(
      "UPDATE collections SET status = 'failed', attempt_finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
    ).run(finishedAtIso, error, id);
  }

  /** Record a logical hour that was skipped because another collection overlapped it (3.10). */
  markMissedHour(logicalHour: number, finishedAtIso: string, error: string): void {
    this.stmt(
      "INSERT INTO collections (logical_hour, attempt_started_at, attempt_finished_at, roster_size, status, error) VALUES (?, ?, ?, 0, 'missed', ?)",
    ).run(logicalHour, finishedAtIso, finishedAtIso, error);
  }

  getCollection(id: number): { id: number; logicalHour: number; status: string; rosterSize: number; error: string | null } | null {
    const row = this.stmt<{ id: number; logical_hour: number; status: string; roster_size: number; error: string | null }, [number]>(
      "SELECT id, logical_hour, status, roster_size, error FROM collections WHERE id = ?",
    ).get(id);
    if (!row) return null;
    return {
      id: row.id,
      logicalHour: row.logical_hour,
      status: row.status,
      rosterSize: row.roster_size,
      error: row.error,
    };
  }

  /** Latest published collection = the graph's "current" point (5.6). */
  getLatestPublishedCollection(): CollectionRef | null {
    const row = this.stmt<{ id: number; logical_hour: number }, []>(
      "SELECT id, logical_hour FROM collections WHERE status = 'published' ORDER BY logical_hour DESC LIMIT 1",
    ).get();
    return row ? { id: row.id, logicalHour: row.logical_hour } : null;
  }

  /** Up to `limit` published collections immediately before (and including) the given one. */
  getPublishedCollectionsBefore(latestLogicalHour: number, limit: number): CollectionRef[] {
    return this.stmt<{ id: number; logical_hour: number }, [number, number]>(
      "SELECT id, logical_hour FROM collections WHERE status = 'published' AND logical_hour <= ? ORDER BY logical_hour DESC LIMIT ?",
    ).all(latestLogicalHour, limit).map((r) => ({ id: r.id, logicalHour: r.logical_hour }));
  }

  /** Published collections at the same UTC hour-of-day, for the 7-day axis (5.5). */
  getPublishedCollectionsSameHour(latestLogicalHour: number, limit: number): CollectionRef[] {
    return this.stmt<{ id: number; logical_hour: number }, [number, string, number]>(
      `SELECT id, logical_hour FROM collections
       WHERE status = 'published' AND logical_hour <= ?
         AND strftime('%H', logical_hour, 'unixepoch') = ?
       ORDER BY logical_hour DESC LIMIT ?`,
    ).all(latestLogicalHour, new Date(latestLogicalHour * 1000).toISOString().slice(11, 13), limit).map((r) => ({
      id: r.id,
      logicalHour: r.logical_hour,
    }));
  }

  getCollectionTimestamp(collectionId: number): number | null {
    const row = this.stmt<{ logical_hour: number }, [number]>("SELECT logical_hour FROM collections WHERE id = ?").get(
      collectionId,
    );
    return row ? row.logical_hour : null;
  }

  // ----------------------------------------------------- profile_snapshots (4.4)

  insertSnapshots(snapshots: SnapshotInput[]): void {
    const run = this.db.transaction(() => {
      for (const s of snapshots) {
        this.stmt(
          `INSERT OR REPLACE INTO profile_snapshots (
             collection_id, user_id, mode, gathered_at,
             pp, global_rank, country_rank, accuracy, max_combo,
             ranked_score, total_score, total_hits,
             play_count, play_time, replay_views,
             level, level_progress,
             grade_ss, grade_ssh, grade_s, grade_sh, grade_a,
             count_300, count_100, count_50, count_miss
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
             CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER),
             CAST(? AS INTEGER), ?, CAST(? AS INTEGER),
             ?, ?,
             CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER),
             CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER))`,
        ).run(
          s.collectionId,
          s.userId,
          s.mode,
          s.gatheredAt,
          s.pp,
          s.globalRank,
          s.countryRank,
          s.accuracy,
          s.maxCombo,
          intBind(s.rankedScore),
          intBind(s.totalScore),
          intBind(s.totalHits),
          intBind(s.playCount),
          s.playTime,
          intBind(s.replayViews),
          s.level,
          s.levelProgress,
          intBind(s.gradeSs),
          intBind(s.gradeSsh),
          intBind(s.gradeS),
          intBind(s.gradeSh),
          intBind(s.gradeA),
          intBind(s.count300),
          intBind(s.count100),
          intBind(s.count50),
          intBind(s.countMiss),
        );
      }
    });
    run();
  }

  /** One player's value for `column` (whitelisted) per collection. TEXT-cast for big ints. */
  getSnapshotValues(
    column: string,
    mode: GameMode,
    collectionIds: number[],
  ): Map<number, Map<number, StoredInt | null>> {
    const col = assertColumn(column);
    const result = new Map<number, Map<number, StoredInt | null>>();
    if (collectionIds.length === 0) return result;
    const placeholders = collectionIds.map(() => "?").join(", ");
    const rows = this.stmt<{ user_id: number; collection_id: number; v: string | null }, any[]>(
      `SELECT user_id, collection_id, CAST(${col} AS TEXT) AS v
       FROM profile_snapshots WHERE mode = ? AND collection_id IN (${placeholders})`,
    ).all(mode, ...collectionIds) as Array<{ user_id: number; collection_id: number; v: string | null }>;
    for (const r of rows) {
      let byCollection = result.get(r.user_id);
      if (!byCollection) {
        byCollection = new Map();
        result.set(r.user_id, byCollection);
      }
      byCollection.set(r.collection_id, r.v === null ? null : parseStoredInt(r.v));
    }
    return result;
  }

  // --------------------------------------------------------------- scores (4.6)

  /**
   * Ingest scores + beatmap metadata and commit the feed cursor atomically
   * (3.3, 4.8). `cursorString` is the persisted cursor returned by the same
   * request; pass null to leave it unchanged.
   */
  ingestScores(
    scores: ScoreInput[],
    beatmaps: BeatmapInput[],
    cursorString: string | null,
    pollAtIso: string,
    ingestAtIso: string,
  ): void {
    const run = this.db.transaction(() => {
      for (const b of beatmaps) {
        this.stmt(
          `INSERT INTO beatmaps (id, beatmapset_id, title, artist, difficulty_name, star_rating, length_seconds, status, cover_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             title = COALESCE(excluded.title, title), artist = COALESCE(excluded.artist, artist),
             difficulty_name = COALESCE(excluded.difficulty_name, difficulty_name),
             star_rating = COALESCE(excluded.star_rating, star_rating),
             length_seconds = COALESCE(excluded.length_seconds, length_seconds),
             status = COALESCE(excluded.status, status),
             cover_url = COALESCE(excluded.cover_url, cover_url)`,
        ).run(b.id, b.beatmapsetId, b.title, b.artist, b.difficultyName, b.starRating, b.lengthSeconds, b.status, b.coverUrl);
      }
      for (const s of scores) {
        this.stmt(
          `INSERT INTO scores (
             id, player_id, beatmap_id, mode, ended_at, started_at, pp, accuracy,
             total_score, classic_total_score, legacy_total_score, legacy_score_id, score_type,
             grade, combo, perfect_combo, mods, has_replay,
             count_300, count_100, count_50, count_geki, count_katu, count_miss, captured_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
             CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ?,
             ?, ?, ?, ?, ?,
             CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), ?)
           ON CONFLICT (id) DO UPDATE SET
             pp = COALESCE(excluded.pp, pp),
             total_score = COALESCE(excluded.total_score, total_score),
             captured_at = excluded.captured_at`,
        ).run(
          s.id,
          s.playerId,
          s.beatmapId,
          s.mode,
          s.endedAt,
          s.startedAt,
          s.pp,
          s.accuracy,
          intBind(s.totalScore),
          intBind(s.classicTotalScore),
          intBind(s.legacyTotalScore),
          s.legacyScoreId,
          s.scoreType,
          s.grade,
          s.combo,
          s.perfectCombo ? 1 : 0,
          s.mods,
          s.hasReplay ? 1 : 0,
          intBind(s.count300),
          intBind(s.count100),
          intBind(s.count50),
          intBind(s.countGeki),
          intBind(s.countKatu),
          intBind(s.countMiss),
          s.capturedAt,
        );
      }
      if (cursorString !== null) {
        this.stmt(
          `UPDATE collector_state SET cursor_string = ?, last_score_poll_at = ?, last_ingest_at = ?,
             change_seq = change_seq + 1, change_kind = 'scores' WHERE id = 1`,
        ).run(cursorString, pollAtIso, ingestAtIso);
      } else {
        this.stmt("UPDATE collector_state SET last_score_poll_at = ? WHERE id = 1").run(pollAtIso);
      }
    });
    run();
  }

  /** Upsert beatmap metadata only (enrichment pass, 3.11). */
  upsertBeatmaps(beatmaps: BeatmapInput[]): void {
    const run = this.db.transaction(() => {
      for (const b of beatmaps) {
        this.stmt(
          `INSERT INTO beatmaps (id, beatmapset_id, title, artist, difficulty_name, star_rating, length_seconds, status, cover_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             title = COALESCE(excluded.title, title), artist = COALESCE(excluded.artist, artist),
             difficulty_name = COALESCE(excluded.difficulty_name, difficulty_name),
             star_rating = COALESCE(excluded.star_rating, star_rating),
             length_seconds = COALESCE(excluded.length_seconds, length_seconds),
             status = COALESCE(excluded.status, status),
             cover_url = COALESCE(excluded.cover_url, cover_url)`,
        ).run(b.id, b.beatmapsetId, b.title, b.artist, b.difficultyName, b.starRating, b.lengthSeconds, b.status, b.coverUrl);
      }
    });
    run();
  }

  /** 10 newest captured completed plays for a mode (5.10), active members only (3.12). */
  getRecentPlays(mode: GameMode, limit: number): LivePlay[] {
    const rows = this.stmt<
      {
        id: number;
        player_id: number;
        username: string;
        avatar_url: string | null;
        beatmap_id: number;
        title: string | null;
        artist: string | null;
        difficulty_name: string | null;
        star_rating: number | null;
        cover_url: string | null;
        grade: string;
        mods: string;
        pp: number | null;
        accuracy: number | null;
        total_score: string | null;
        combo: number | null;
        ended_at: string;
      },
      [string, number]
    >(
      `SELECT s.id, s.player_id, m.username, m.avatar_url, s.beatmap_id,
              b.title, b.artist, b.difficulty_name, b.star_rating, b.cover_url,
              s.grade, s.mods, s.pp, s.accuracy, CAST(s.total_score AS TEXT) AS total_score,
              s.combo, s.ended_at
       FROM scores s
       JOIN members m ON m.user_id = s.player_id AND m.status = 'active'
       LEFT JOIN beatmaps b ON b.id = s.beatmap_id
       WHERE s.mode = ?
       ORDER BY s.ended_at DESC, s.id DESC
       LIMIT ?`,
    ).all(mode, limit);

    return rows.map((r) => ({
      scoreId: r.id,
      userId: r.player_id,
      username: r.username,
      avatarUrl: r.avatar_url,
      beatmapId: r.beatmap_id,
      beatmapTitle: r.title,
      beatmapArtist: r.artist,
      difficultyName: r.difficulty_name,
      starRating: r.star_rating,
      coverUrl: r.cover_url,
      grade: r.grade,
      mods: r.mods,
      pp: r.pp,
      accuracy: r.accuracy,
      score: r.total_score === null ? null : (toApiNumber(parseStoredInt(r.total_score)) as string | number | null),
      maxCombo: r.combo,
      endedAt: r.ended_at,
    }));
  }

  /** Beatmap IDs of captured scores whose metadata was not supplied by the feed (3.11). */
  getMissingBeatmapIds(limit: number): number[] {
    return this.stmt<{ id: number }, [number]>(
      `SELECT DISTINCT s.beatmap_id AS id FROM scores s LEFT JOIN beatmaps b ON b.id = s.beatmap_id
       WHERE b.id IS NULL LIMIT ?`,
    ).all(limit).map((r) => r.id);
  }

  // ---------------------------------------------------------------- state (4.8)

  getState(): {
    cursorString: string | null;
    lastScorePollAt: string | null;
    lastIngestAt: string | null;
    teamSyncedAt: string | null;
    lastCollectionId: number | null;
    changeSeq: number;
    changeKind: string | null;
  } {
    const row = this.stmt<
      {
        cursor_string: string | null;
        last_score_poll_at: string | null;
        last_ingest_at: string | null;
        team_synced_at: string | null;
        last_collection_id: number | null;
        change_seq: number;
        change_kind: string | null;
      },
      []
    >("SELECT * FROM collector_state WHERE id = 1").get();
    if (!row) throw new Error("collector_state is empty — run migrations");
    return {
      cursorString: row.cursor_string,
      lastScorePollAt: row.last_score_poll_at,
      lastIngestAt: row.last_ingest_at,
      teamSyncedAt: row.team_synced_at,
      lastCollectionId: row.last_collection_id,
      changeSeq: row.change_seq,
      changeKind: row.change_kind,
    };
  }

  markTeamSynced(atIso: string): void {
    this.stmt(
      "UPDATE collector_state SET team_synced_at = ?, change_seq = change_seq + 1, change_kind = 'collection' WHERE id = 1",
    ).run(atIso);
  }

  /**
   * Publish an hourly collection atomically (3.9): snapshots, collection status
   * and collector_state are committed in one transaction. Throws if another
   * published collection already occupies this logical hour.
   */
  publishHourlyCollection(input: {
    collectionId: number;
    snapshots: SnapshotInput[];
    finishedAtIso: string;
  }): void {
    const run = this.db.transaction(() => {
      this.insertSnapshots(input.snapshots);
      // Guard: only one published collection per logical hour (4.3).
      const existing = this.stmt<{ id: number }, [number, number]>(
        "SELECT id FROM collections WHERE logical_hour = (SELECT logical_hour FROM collections WHERE id = ?) AND status = 'published' AND id != ?",
      ).get(input.collectionId, input.collectionId);
      if (existing) {
        throw new Error(`logical hour already has a published collection (id ${existing.id})`);
      }
      this.publishCollection(input.collectionId, input.finishedAtIso);
      const after = this.getCollection(input.collectionId);
      if (!after || after.status !== "published") {
        throw new Error("failed to publish collection");
      }
      this.stmt(
        "UPDATE collector_state SET last_collection_id = ?, change_seq = change_seq + 1, change_kind = 'collection' WHERE id = 1",
      ).run(input.collectionId);
    });
    try {
      run();
    } catch (err) {
      // The transaction rolled back — record the failed attempt (3.9).
      this.failCollection(input.collectionId, input.finishedAtIso, (err as Error).message);
      throw err;
    }
  }

  /** Current change sequence + kind, polled by the web backend for SSE (6.5). */
  getChangeSequence(): { seq: number; kind: string | null } {
    const row = this.stmt<{ change_seq: number; change_kind: string | null }, []>(
      "SELECT change_seq, change_kind FROM collector_state WHERE id = 1",
    ).get();
    return { seq: row?.change_seq ?? 0, kind: row?.change_kind ?? null };
  }

  /** Test/diagnostic helper. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.db.close();
  }
}

/** Compute the UTC hour start (epoch seconds) containing `timestampMs`. */
export function logicalHourOf(timestampMs: number): number {
  return Math.floor(timestampMs / 3_600_000) * 3600;
}

/** Re-export for callers building API payloads. */
export { toApiNumber, parseStoredInt };
export type { MetricKey, LiveSortKey };
