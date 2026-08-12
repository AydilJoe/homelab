import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchLike, FetchLikeResponse, MediaRow } from "../src/types.js";

/** A throwaway media tree plus a DB path, both under one temp directory. */
export interface Fixture {
  root: string;
  mediaRoot: string;
  dbPath: string;
  cleanup(): void;
}

/**
 * Build a fixture tree of dummy media files. Values are file sizes in bytes —
 * the content is zeroes, nothing ever reads it, but a non-zero size keeps
 * size_bytes meaningful.
 */
export function createFixture(files: Record<string, number>): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "addon-test-"));
  const mediaRoot = path.join(root, "media");
  fs.mkdirSync(mediaRoot, { recursive: true });

  for (const [relPath, size] of Object.entries(files)) {
    const absolute = path.join(mediaRoot, relPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.alloc(size));
  }

  return {
    root,
    mediaRoot,
    dbPath: path.join(root, "config", "index.db"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export interface FetchStub {
  fetch: FetchLike;
  calls: string[];
}

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Fake `fetch` for the *arr and Cinemeta clients. Routes are matched by
 * substring against the request URL, first match wins; anything unrouted is a
 * 404 so a test that accidentally reaches for the network fails loudly.
 */
export function createFetchStub(routes: Array<[string, unknown]>): FetchStub {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const route = routes.find(([pattern]) => url.includes(pattern));
    if (!route) return jsonResponse(404, { error: `no stub for ${url}` });
    return jsonResponse(200, route[1]);
  };
  return { fetch: fetchImpl, calls };
}

/** A media row with sensible defaults, for tests that only care about a field or two. */
export function mediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    imdb_id: "tt0111161",
    type: "movie",
    season: 0,
    episode: 0,
    title: "The Shawshank Redemption",
    year: 1994,
    rel_path: "movies/The Shawshank Redemption (1994)/film.mkv",
    size_bytes: 4_509_715_660,
    resolution: "1080p",
    video_codec: "H.264",
    audio_codec: "AAC",
    match_source: "radarr",
    mtime: 1_700_000_000,
    ...overrides,
  };
}
