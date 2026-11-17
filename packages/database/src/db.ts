import { Database as SqliteDatabase } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export { DatabaseError } from "./errors.ts";

export interface OpenOptions {
  path: string;
  readonly?: boolean;
}

/**
 * Open the SQLite database with WAL enabled (one writer — the collector — and
 * concurrent readers, spec 1.5), foreign keys enforced (4.10) and a busy
 * timeout so web-backend reads never fail while the collector writes.
 */
export function openDatabase(options: OpenOptions): SqliteDatabase {
  const db = options.readonly
    ? new SqliteDatabase(options.path, { readonly: true })
    : new SqliteDatabase(options.path);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

const MIGRATIONS = import.meta.dir + "/../migrations";

/** Apply versioned migrations in order (4.10). Idempotent. */
export function migrate(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );

  const files = Array.from(new Bun.Glob("*.sql").scanSync({ cwd: MIGRATIONS })).sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (!Number.isInteger(version)) {
      throw new Error(`migration file has no numeric version prefix: ${file}`);
    }
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
    });
    apply();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
