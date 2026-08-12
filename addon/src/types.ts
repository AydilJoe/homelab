/**
 * Shared value types. Row shapes mirror the schema in spec section 6.4 exactly,
 * including snake_case column names, so a row can go straight from SQLite into
 * these types without a translation layer.
 */

export type MediaType = "movie" | "series";

export type MatchSource = "radarr" | "sonarr" | "cinemeta";

/** One row of `media`. Movies use season = 0, episode = 0 (never NULL — 6.4). */
export interface MediaRow {
  imdb_id: string;
  type: MediaType;
  season: number;
  episode: number;
  title: string;
  year: number | null;
  /** Path relative to MEDIA_ROOT, POSIX separators, no leading slash. */
  rel_path: string;
  size_bytes: number;
  resolution: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  match_source: MatchSource;
  /** Unix epoch seconds. */
  mtime: number;
}

/** One row of `unmatched`. A file that resolved to no IMDb ID is recorded, never dropped. */
export interface UnmatchedRow {
  rel_path: string;
  reason: string;
  seen_at: number;
}

/** One catalogue tile's worth of data: media rows collapsed to one row per title. */
export interface CatalogRow {
  imdb_id: string;
  type: MediaType;
  title: string;
  year: number | null;
}

/** A video file found on disk by the indexer. */
export interface ScannedFile {
  rel_path: string;
  size_bytes: number;
  mtime: number;
}

/**
 * The slice of `fetch` this codebase uses. Narrow on purpose: tests inject a
 * plain function and never touch the network (6.9), and the global `fetch` is
 * assignable to it.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Minimal logger so tests can stay quiet without stubbing the console. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
