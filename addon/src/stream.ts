import type { Stream, StreamArgs, StreamResult } from "stremio-addon-sdk";
import type { MediaIndex } from "./db.js";
import { CACHE } from "./manifest.js";
import type { MediaRow } from "./types.js";

/**
 * Stream handler. The addon returns URLs and never proxies bytes — Caddy's
 * file_server serves the files and handles Range requests (6.6).
 */

const IMDB_ID_RE = /^tt\d{6,}$/;
const NUMBER_RE = /^\d{1,4}$/;

/** Best-first ordering (decision O2). Unknown resolution sorts last. */
const RESOLUTION_RANK: Record<string, number> = {
  "2160p": 5,
  "1440p": 4,
  "1080p": 3,
  "720p": 2,
  "576p": 1,
  "480p": 0,
};

export interface StremioId {
  imdbId: string;
  season: number;
  episode: number;
}

/**
 * Series IDs arrive as `tt1234567:1:5`; movie IDs as `tt1234567`. Movies are
 * stored with season 0 / episode 0, so both shapes end up as one lookup.
 * Anything else is malformed and yields null (never a throw).
 */
export function parseStremioId(id: string): StremioId | null {
  const parts = (id ?? "").trim().split(":");
  const imdbId = parts[0] ?? "";
  if (!IMDB_ID_RE.test(imdbId)) return null;

  if (parts.length === 1) return { imdbId, season: 0, episode: 0 };
  if (parts.length !== 3) return null;

  const season = parts[1] ?? "";
  const episode = parts[2] ?? "";
  if (!NUMBER_RE.test(season) || !NUMBER_RE.test(episode)) return null;

  return { imdbId, season: Number.parseInt(season, 10), episode: Number.parseInt(episode, 10) };
}

/**
 * PUBLIC_BASE_URL + "/media/" + rel_path, each path segment percent-encoded so
 * spaces and brackets survive; the separators stay literal slashes.
 */
export function buildMediaUrl(publicBaseUrl: string, relPath: string): string {
  const encoded = relPath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${publicBaseUrl.replace(/\/+$/, "")}/media/${encoded}`;
}

/** Binary units under decimal labels, which is what players and trackers show. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gigabytes = bytes / 1024 ** 3;
  if (gigabytes >= 1) return `${gigabytes.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** "1080p • H.264 • 4.2 GB" — unknown fields are dropped, size is always there. */
export function describeStream(row: MediaRow): string {
  const parts: string[] = [];
  if (row.resolution) parts.push(row.resolution);
  if (row.video_codec) parts.push(row.video_codec);
  parts.push(formatSize(row.size_bytes));
  return parts.join(" • ");
}

function rank(row: MediaRow): number {
  return row.resolution ? (RESOLUTION_RANK[row.resolution] ?? -1) : -1;
}

/** O2: every matching file is returned as its own stream, best first. */
export function sortBestFirst(rows: MediaRow[]): MediaRow[] {
  return [...rows].sort((a, b) => {
    const byResolution = rank(b) - rank(a);
    if (byResolution !== 0) return byResolution;
    const bySize = b.size_bytes - a.size_bytes;
    if (bySize !== 0) return bySize;
    return a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0;
  });
}

export function toStream(row: MediaRow, publicBaseUrl: string): Stream {
  const line = describeStream(row);
  const filename = row.rel_path.split("/").pop() ?? row.rel_path;
  return {
    name: "Local",
    // `description` supersedes the deprecated `title`; both are set so the
    // codec/size line renders on every client generation (6.6).
    description: line,
    title: line,
    url: buildMediaUrl(publicBaseUrl, row.rel_path),
    behaviorHints: {
      bingeGroup: `local-${row.imdb_id}`,
      videoSize: row.size_bytes,
      filename,
    },
  };
}

export interface StreamHandlerDeps {
  db: MediaIndex;
  publicBaseUrl: string;
}

export function createStreamHandler(deps: StreamHandlerDeps) {
  return async function streamHandler(args: StreamArgs): Promise<StreamResult> {
    // An unknown or malformed id is an empty list, never a 404 and never a 500.
    const parsed = parseStremioId(args.id);
    if (!parsed) return { streams: [], ...CACHE.stream };

    const rows = deps.db.streamsFor(parsed.imdbId, parsed.season, parsed.episode);
    const streams = sortBestFirst(rows).map((row) => toStream(row, deps.publicBaseUrl));
    return { streams, ...CACHE.stream };
  };
}
