import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CatalogRow, MediaRow, MediaType, UnmatchedRow } from "./types.js";

/**
 * Schema is spec section 6.4 verbatim.
 *
 * Two things here are load-bearing and must not be "simplified":
 *  - movies use season = 0 / episode = 0 rather than NULL, because SQLite
 *    treats NULLs in a composite primary key as distinct, which would leave
 *    movie rows with no uniqueness enforcement at all;
 *  - rel_path alone is NOT unique — a multi-episode file (S01E01E02) is one
 *    row per episode sharing a rel_path.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  imdb_id      TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('movie','series')),
  season       INTEGER NOT NULL DEFAULT 0,
  episode      INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,
  year         INTEGER,
  rel_path     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  resolution   TEXT,
  video_codec  TEXT,
  audio_codec  TEXT,
  match_source TEXT NOT NULL CHECK (match_source IN ('radarr','sonarr','cinemeta')),
  mtime        INTEGER NOT NULL,
  PRIMARY KEY (imdb_id, season, episode, rel_path),
  UNIQUE (rel_path, season, episode)
);
CREATE INDEX IF NOT EXISTS idx_media_lookup ON media (imdb_id, season, episode);
CREATE INDEX IF NOT EXISTS idx_media_title  ON media (title);

CREATE TABLE IF NOT EXISTS unmatched (
  rel_path  TEXT PRIMARY KEY,
  reason    TEXT NOT NULL,
  seen_at   INTEGER NOT NULL
);
`;

export interface CatalogQuery {
  type: MediaType;
  search?: string | undefined;
  skip?: number;
  limit?: number;
}

/** Identity of a file resolved through Cinemeta on a previous rescan. */
export interface CachedResolution {
  imdb_id: string;
  type: MediaType;
  title: string;
  year: number | null;
}

/** Escape the LIKE wildcards so a search for "50%" does not match everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class MediaIndex {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    try {
      if (dbPath !== ":memory:") {
        fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
      }
      this.db = new Database(dbPath);
    } catch (error) {
      // This container runs as uid 1000 (`USER node`) from its first
      // instruction, unlike the linuxserver images, which start as root and
      // chown /config themselves. Docker creates a MISSING bind-mount source as
      // root:root 0755, so on a fresh `docker compose up -d` the addon cannot
      // create its database — and `restart: unless-stopped` turns a raw stack
      // trace into a crash loop. Say what to do instead.
      throw new Error(
        `cannot open the index database at ${dbPath}: ${String(error)}\n` +
          "The addon runs as uid 1000 and needs to own its config directory. On the LXC:\n" +
          "  mkdir -p ${CONFIG_ROOT}/addon && chown 1000:1000 ${CONFIG_ROOT}/addon\n" +
          "then `docker compose up -d addon`. The index is derived state (N5) — deleting it is always safe.",
        { cause: error },
      );
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM media").get() as { n: number };
    return row.n;
  }

  unmatchedCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM unmatched").get() as { n: number };
    return row.n;
  }

  /**
   * The index is derived state (N5): a rescan replaces it wholesale inside one
   * transaction. That is also what makes a rescan idempotent — two runs over an
   * unchanged library produce identical row counts.
   */
  replaceAll(media: MediaRow[], unmatched: UnmatchedRow[]): void {
    // INSERT OR REPLACE: if two sources disagree about a (rel_path, season,
    // episode) the last write wins rather than aborting the whole rescan.
    const insertMedia = this.db.prepare(`
      INSERT OR REPLACE INTO media
        (imdb_id, type, season, episode, title, year, rel_path, size_bytes,
         resolution, video_codec, audio_codec, match_source, mtime)
      VALUES
        (@imdb_id, @type, @season, @episode, @title, @year, @rel_path, @size_bytes,
         @resolution, @video_codec, @audio_codec, @match_source, @mtime)
    `);
    const insertUnmatched = this.db.prepare(`
      INSERT OR REPLACE INTO unmatched (rel_path, reason, seen_at)
      VALUES (@rel_path, @reason, @seen_at)
    `);

    const swap = this.db.transaction((mediaRows: MediaRow[], unmatchedRows: UnmatchedRow[]) => {
      this.db.exec("DELETE FROM media; DELETE FROM unmatched;");
      for (const row of mediaRows) insertMedia.run(row);
      for (const row of unmatchedRows) insertUnmatched.run(row);
    });

    swap(media, unmatched);
  }

  /**
   * Previously Cinemeta-resolved files, keyed by rel_path. Reusing these keeps
   * the network lookup to once per file rather than once per rescan (6.3).
   */
  cachedCinemetaResolutions(): Map<string, CachedResolution> {
    const rows = this.db
      .prepare(
        `SELECT rel_path, imdb_id, type, title, year
           FROM media
          WHERE match_source = 'cinemeta'`,
      )
      .all() as Array<CachedResolution & { rel_path: string }>;

    const byPath = new Map<string, CachedResolution>();
    for (const row of rows) {
      // All rows sharing a rel_path share an identity, so first one wins.
      if (!byPath.has(row.rel_path)) {
        byPath.set(row.rel_path, {
          imdb_id: row.imdb_id,
          type: row.type,
          title: row.title,
          year: row.year,
        });
      }
    }
    return byPath;
  }

  /** One row per title (episodes collapsed), alphabetical, paged. */
  catalog(query: CatalogQuery): CatalogRow[] {
    const limit = query.limit ?? 100;
    const skip = query.skip ?? 0;
    // Defensive: the SDK hands `extra` values through as strings OR arrays and
    // createCatalogHandler normalises them, but this must not throw whatever
    // arrives — a TypeError here becomes an HTTP 500, the one shape 6.9 forbids.
    const search = typeof query.search === "string" ? query.search.trim() : undefined;

    const where = search ? "type = ? AND title LIKE ? ESCAPE '\\'" : "type = ?";
    const params: Array<string | number> = search
      ? [query.type, `%${escapeLike(search)}%`]
      : [query.type];

    const rows = this.db
      .prepare(
        `SELECT imdb_id, MIN(title) AS title, MAX(year) AS year
           FROM media
          WHERE ${where}
          GROUP BY imdb_id
          ORDER BY title ASC, imdb_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, skip) as Array<{
      imdb_id: string;
      title: string;
      year: number | null;
    }>;

    return rows.map((row) => ({ ...row, type: query.type }));
  }

  /** Every file for one title/episode — several rows when qualities duplicate (O2). */
  streamsFor(imdbId: string, season: number, episode: number): MediaRow[] {
    return this.db
      .prepare(
        `SELECT * FROM media
          WHERE imdb_id = ? AND season = ? AND episode = ?`,
      )
      .all(imdbId, season, episode) as MediaRow[];
  }

  /** Test/debug helper: every row, insertion order irrelevant. */
  allMedia(): MediaRow[] {
    return this.db
      .prepare("SELECT * FROM media ORDER BY rel_path, season, episode")
      .all() as MediaRow[];
  }

  allUnmatched(): UnmatchedRow[] {
    return this.db.prepare("SELECT * FROM unmatched ORDER BY rel_path").all() as UnmatchedRow[];
  }

  close(): void {
    this.db.close();
  }
}
