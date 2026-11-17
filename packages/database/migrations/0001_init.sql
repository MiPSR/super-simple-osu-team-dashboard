-- Versioned schema, migration 0001 (spec section 4).
-- Foreign keys are enabled per connection by the database package.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE team (
  id INTEGER PRIMARY KEY,              -- configured osu! team ID (4.1)
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  flag_url TEXT,                       -- logo/flag image URL
  cover_url TEXT,
  default_mode TEXT NOT NULL,          -- 'osu' | 'taiko' | 'fruits' | 'mania'
  synced_at TEXT NOT NULL              -- last successful team synchronization
);

CREATE TABLE members (
  user_id INTEGER PRIMARY KEY,         -- stable osu! user ID (4.2)
  username TEXT NOT NULL,
  avatar_url TEXT,
  country_code TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'former')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,     -- unique collection ID (4.3)
  logical_hour INTEGER NOT NULL,            -- start epoch second of the UTC hour
  attempt_started_at TEXT NOT NULL,
  attempt_finished_at TEXT,
  roster_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'published', 'failed', 'missed')),
  error TEXT
);
-- A logical hour can have only one published successful collection.
CREATE UNIQUE INDEX idx_collections_published_hour
  ON collections (logical_hour) WHERE status = 'published';
CREATE INDEX idx_collections_status ON collections (status, logical_hour);

CREATE TABLE profile_snapshots (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('osu', 'taiko', 'fruits', 'mania')),
  gathered_at TEXT NOT NULL,           -- actual gathering timestamp (diagnostics only, 3.8)
  -- Performance (4.4)
  pp REAL,
  global_rank INTEGER,
  country_rank INTEGER,
  accuracy REAL,                       -- fraction 0..1 (4.5)
  max_combo INTEGER,
  -- Scores
  ranked_score INTEGER,
  total_score INTEGER,
  total_hits INTEGER,
  -- Activity
  play_count INTEGER,
  play_time INTEGER,                   -- cumulative seconds
  replay_views INTEGER,
  -- Progression
  level INTEGER,
  level_progress INTEGER,              -- 0..100
  -- Grades
  grade_ss INTEGER,
  grade_ssh INTEGER,
  grade_s INTEGER,
  grade_sh INTEGER,
  grade_a INTEGER,
  -- Hit statistics
  count_300 INTEGER,
  count_100 INTEGER,
  count_50 INTEGER,
  count_miss INTEGER,
  PRIMARY KEY (collection_id, user_id, mode)
);

CREATE TABLE scores (
  id INTEGER PRIMARY KEY,              -- unique osu! score ID (4.6)
  player_id INTEGER NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  beatmap_id INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('osu', 'taiko', 'fruits', 'mania')),
  ended_at TEXT NOT NULL,              -- completion timestamp
  started_at TEXT,
  pp REAL,                             -- nullable
  accuracy REAL,                       -- fraction 0..1
  total_score INTEGER,                 -- lazer standardised score
  classic_total_score INTEGER,         -- lazer classic scoring variant
  legacy_total_score INTEGER,          -- stable "score v1" (0 on lazer scores)
  legacy_score_id INTEGER,             -- set on stable scores only
  score_type TEXT,                     -- osu!api Score "type" (stable/lazer distinction)
  grade TEXT NOT NULL,
  combo INTEGER,
  perfect_combo INTEGER,               -- is_perfect_combo || legacy_perfect
  mods TEXT NOT NULL,                  -- JSON array of mods
  has_replay INTEGER NOT NULL DEFAULT 0,
  count_300 INTEGER,
  count_100 INTEGER,
  count_50 INTEGER,
  count_geki INTEGER,
  count_katu INTEGER,
  count_miss INTEGER,
  captured_at TEXT NOT NULL            -- when the collector observed the score
);

CREATE INDEX idx_scores_mode_ended ON scores (mode, ended_at);
CREATE INDEX idx_scores_player ON scores (player_id, ended_at);
CREATE INDEX idx_scores_beatmap ON scores (beatmap_id);

CREATE TABLE beatmaps (
  id INTEGER PRIMARY KEY,              -- beatmap ID (4.7)
  beatmapset_id INTEGER NOT NULL,
  title TEXT,
  artist TEXT,
  difficulty_name TEXT,
  star_rating REAL,
  length_seconds INTEGER,
  status TEXT,
  cover_url TEXT                       -- available artwork reference
);

CREATE TABLE collector_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_string TEXT,                  -- durable score-feed cursor (4.8)
  last_score_poll_at TEXT,
  last_ingest_at TEXT,
  team_synced_at TEXT,
  last_collection_id INTEGER REFERENCES collections(id),
  change_seq INTEGER NOT NULL DEFAULT 0, -- monotonic change sequence for SSE (6.5)
  change_kind TEXT                     -- 'scores' | 'collection' of the last change
);

INSERT INTO collector_state (id, change_seq) VALUES (1, 0);
