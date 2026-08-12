import fs from "node:fs/promises";
import path from "node:path";
import type { ArrMatch, RadarrClient, SonarrClient } from "./arr.js";
import type { CinemetaClient } from "./cinemeta.js";
import type { MediaIndex } from "./db.js";
import { MAX_EPISODE_SPAN, parseFilename } from "./parser.js";
import type { Logger, MatchSource, MediaRow, MediaType, ScannedFile, UnmatchedRow } from "./types.js";
import { silentLogger } from "./types.js";

/**
 * The indexer: filesystem -> IMDb IDs -> the `media` table.
 *
 * It only ever walks MEDIA_ROOT, which is why the torrents tree is skipped by
 * construction rather than by an exclusion list — /data/torrents is simply not
 * mounted into this container.
 */

export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".webm"]);

export interface ReindexDeps {
  db: MediaIndex;
  mediaRoot: string;
  radarr?: RadarrClient | null;
  sonarr?: SonarrClient | null;
  cinemeta?: CinemetaClient | null;
  logger?: Logger;
  /** Injectable clock (epoch seconds) so tests are deterministic. */
  now?: () => number;
  /**
   * Permit a scan that found nothing to empty a previously non-empty index.
   * Default false: on the LXC the media root is a bind mount, and a mount that
   * is not ready yet is indistinguishable from an empty library.
   */
  allowEmpty?: boolean;
}

export interface ReindexResult {
  files: number;
  rows: number;
  unmatched: number;
  durationMs: number;
  /**
   * Set when the run refused to write. The previous index is intact and the
   * numbers above describe it, not this scan.
   */
  aborted?: string;
}

interface Identity {
  imdbId: string;
  type: MediaType;
  season: number;
  episode: number;
  title: string;
  year: number | null;
  matchSource: MatchSource;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Thrown when the media root itself cannot be read — never for a subdirectory. */
export class MediaRootUnreadableError extends Error {
  constructor(mediaRoot: string, cause: unknown) {
    super(`media root ${mediaRoot} cannot be read: ${String(cause)}`);
    this.name = "MediaRootUnreadableError";
  }
}

async function walk(
  absoluteDir: string,
  relativeDir: string,
  out: ScannedFile[],
  logger: Logger,
  isRoot = false,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    // A subdirectory that cannot be read costs us those files and nothing else.
    // The ROOT failing is different in kind: it looks exactly like "the library
    // is empty", and an empty scan would replace the whole index with nothing.
    // Let it propagate so reindex can refuse to write.
    if (isRoot) throw new MediaRootUnreadableError(absoluteDir, error);
    logger.warn(`indexer: cannot read ${absoluteDir}: ${String(error)}`);
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(absoluteDir, entry.name);
    const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;

    // Symlinks report neither isDirectory() nor isFile(), so they are skipped.
    // The library is built from hardlinks (C4), not symlinks.
    if (entry.isDirectory()) {
      await walk(absolute, relative, out, logger);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    try {
      const stats = await fs.stat(absolute);
      out.push({
        rel_path: relative,
        size_bytes: stats.size,
        mtime: Math.floor(stats.mtimeMs / 1000),
      });
    } catch (error) {
      logger.warn(`indexer: cannot stat ${absolute}: ${String(error)}`);
    }
  }
}

/**
 * Every video file under the media root, rel_path relative to it, sorted for
 * determinism. Throws `MediaRootUnreadableError` if the root itself is missing
 * or unreadable — that must not be mistaken for an empty library.
 */
export async function scanMediaRoot(mediaRoot: string, logger: Logger = silentLogger): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  await walk(mediaRoot, "", files, logger, true);
  files.sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0));
  return files;
}

/**
 * Map an *arr file path onto a scanned rel_path.
 *
 * The *arrs report absolute paths in their own mount namespace (/data/media/…)
 * while this container sees MEDIA_ROOT (/data/media) — but the prefixes are not
 * guaranteed to agree, so match on the longest path suffix that is an actual
 * scanned rel_path. Only real rel_paths can ever be returned, so a short suffix
 * cannot invent a match.
 */
export function matchRelPath(arrPath: string, byRelPath: ReadonlyMap<string, ScannedFile>): string | null {
  const segments = toPosix(arrPath).split("/").filter((segment) => segment !== "");
  for (let start = 0; start < segments.length; start += 1) {
    const candidate = segments.slice(start).join("/");
    if (byRelPath.has(candidate)) return candidate;
  }
  return null;
}

async function collectArrMatches(deps: ReindexDeps, logger: Logger): Promise<ArrMatch[]> {
  const matches: ArrMatch[] = [];

  if (deps.radarr) {
    try {
      const found = await deps.radarr.collectMatches();
      logger.info(`indexer: radarr returned ${found.length} movie files`);
      matches.push(...found);
    } catch (error) {
      // A dead *arr degrades to the Cinemeta path; it does not fail the rescan.
      logger.error(`indexer: radarr lookup failed: ${String(error)}`);
    }
  }

  if (deps.sonarr) {
    try {
      const found = await deps.sonarr.collectMatches();
      logger.info(`indexer: sonarr returned ${found.length} episode entries`);
      matches.push(...found);
    } catch (error) {
      logger.error(`indexer: sonarr lookup failed: ${String(error)}`);
    }
  }

  return matches;
}

function buildRow(file: ScannedFile, identity: Identity, parsed: ReturnType<typeof parseFilename>): MediaRow {
  return {
    imdb_id: identity.imdbId,
    type: identity.type,
    season: identity.season,
    episode: identity.episode,
    title: identity.title,
    year: identity.year,
    rel_path: file.rel_path,
    size_bytes: file.size_bytes,
    resolution: parsed.resolution,
    video_codec: parsed.videoCodec,
    audio_codec: parsed.audioCodec,
    match_source: identity.matchSource,
    mtime: file.mtime,
  };
}

/**
 * Rebuild the whole index. Safe to run repeatedly: the write is one transaction
 * that replaces the previous contents, so two runs over an unchanged library
 * leave identical rows (6.9).
 */
export async function reindex(deps: ReindexDeps): Promise<ReindexResult> {
  const startedAt = Date.now();
  const logger = deps.logger ?? silentLogger;
  const seenAt = deps.now?.() ?? Math.floor(Date.now() / 1000);

  const abort = (reason: string): ReindexResult => {
    logger.error(`indexer: rescan ABORTED, index left untouched — ${reason}`);
    return {
      files: 0,
      rows: deps.db.count(),
      unmatched: deps.db.unmatchedCount(),
      durationMs: Date.now() - startedAt,
      aborted: reason,
    };
  };

  let files: ScannedFile[];
  try {
    files = await scanMediaRoot(deps.mediaRoot, logger);
  } catch (error) {
    // The media root is a read-only bind mount (§3.2). If it is missing or not
    // mounted yet, the scan is not "an empty library" — writing its result
    // would drop every media row AND the cached Cinemeta resolutions that 6.3
    // exists to avoid re-fetching. Keep what we have.
    return abort(String(error));
  }

  if (files.length === 0 && !deps.allowEmpty && deps.db.count() > 0) {
    return abort(
      `${deps.mediaRoot} is readable but contains no video files, while the index holds ${deps.db.count()} row(s). ` +
        "Refusing to empty it — check that the media bind mount is present. " +
        "If the library really is empty, delete the index DB and restart the addon.",
    );
  }

  const byRelPath = new Map(files.map((file) => [file.rel_path, file]));

  const arrByRelPath = new Map<string, ArrMatch[]>();
  for (const match of await collectArrMatches(deps, logger)) {
    const relPath = matchRelPath(match.path, byRelPath);
    // No relPath means the *arr knows a file this container cannot see — a
    // different library root, or an import that has not landed yet.
    if (!relPath) continue;
    const bucket = arrByRelPath.get(relPath);
    if (bucket) bucket.push(match);
    else arrByRelPath.set(relPath, [match]);
  }

  const cinemetaCache = deps.db.cachedCinemetaResolutions();
  const rows: MediaRow[] = [];
  const unmatched: UnmatchedRow[] = [];
  const reject = (relPath: string, reason: string): void => {
    unmatched.push({ rel_path: relPath, reason, seen_at: seenAt });
    logger.warn(`indexer: unmatched ${relPath} (${reason})`);
  };

  for (const file of files) {
    const parsed = parseFilename(file.rel_path);
    const arrMatches = arrByRelPath.get(file.rel_path);

    // Primary path: one row per (file, episode) the *arrs named. A
    // multi-episode file arrives here as several matches sharing one path.
    if (arrMatches && arrMatches.length > 0) {
      for (const match of arrMatches) {
        rows.push(
          buildRow(
            file,
            {
              imdbId: match.imdbId,
              type: match.type,
              season: match.season,
              episode: match.episode,
              title: match.title,
              year: match.year,
              matchSource: match.matchSource,
            },
            parsed,
          ),
        );
      }
      continue;
    }

    // Fallback path: Cinemeta, cached in the DB so the network lookup happens
    // once per file rather than once per rescan (6.3).
    const cached = cinemetaCache.get(file.rel_path);
    let imdbId = cached?.imdb_id ?? null;
    const type: MediaType = cached?.type ?? (parsed.season !== null ? "series" : "movie");
    let title = cached?.title ?? parsed.title;
    let year = cached?.year ?? parsed.year;

    if (imdbId === null) {
      if (parsed.title.trim() === "") {
        reject(file.rel_path, "filename yielded no title");
        continue;
      }
      if (!deps.cinemeta) {
        reject(file.rel_path, "no *arr match and the cinemeta fallback is disabled");
        continue;
      }
      try {
        const meta = await deps.cinemeta.resolve(type, { title: parsed.title, year: parsed.year });
        if (!meta?.id) {
          reject(file.rel_path, `no confident cinemeta match for "${parsed.title}"`);
          continue;
        }
        imdbId = meta.id;
        title = (meta.name ?? parsed.title).trim();
        year = parsed.year;
      } catch (error) {
        reject(file.rel_path, `cinemeta lookup failed: ${String(error)}`);
        continue;
      }
    }

    if (type === "series") {
      if (parsed.season === null || parsed.episodes.length === 0) {
        reject(
          file.rel_path,
          parsed.episodeSpanRejected
            ? `implausible episode range in the filename (>= ${MAX_EPISODE_SPAN} episodes in one file)`
            : "series file with no season/episode numbers in its name",
        );
        continue;
      }
      for (const episode of parsed.episodes) {
        rows.push(
          buildRow(
            file,
            { imdbId, type, season: parsed.season, episode, title, year, matchSource: "cinemeta" },
            parsed,
          ),
        );
      }
      continue;
    }

    rows.push(
      buildRow(
        file,
        { imdbId, type, season: 0, episode: 0, title, year, matchSource: "cinemeta" },
        parsed,
      ),
    );
  }

  deps.db.replaceAll(rows, unmatched);

  const result: ReindexResult = {
    files: files.length,
    rows: deps.db.count(),
    unmatched: unmatched.length,
    durationMs: Date.now() - startedAt,
  };
  logger.info(
    `indexer: ${result.files} files -> ${result.rows} rows, ${result.unmatched} unmatched (${result.durationMs} ms)`,
  );
  return result;
}

/**
 * Serialises rescans: never two walks over the same tree at once.
 *
 * A request arriving mid-run is NOT dropped. The filesystem walk snapshots the
 * tree when it starts, so a file imported after that point is invisible to the
 * run already in flight — returning that run's promise would answer 202
 * "accepted" for work that can never include the new file, and nothing would
 * pick it up until the next restart. Instead one follow-up run is queued, and
 * the caller's promise resolves from that. At most two runs are ever
 * outstanding no matter how many requests arrive.
 *
 * (Idempotency in 6.9 is about two runs producing identical rows — a property
 * of `replaceAll` — not about coalescing requests away.)
 */
export class ReindexRunner {
  private inFlight: Promise<ReindexResult> | null = null;
  private queued: Promise<ReindexResult> | null = null;
  private releaseQueued: ((result: Promise<ReindexResult>) => void) | null = null;

  constructor(private readonly deps: ReindexDeps) {}

  get isRunning(): boolean {
    return this.inFlight !== null;
  }

  run(): Promise<ReindexResult> {
    if (this.inFlight) {
      if (!this.queued) {
        this.queued = new Promise<ReindexResult>((resolve, reject) => {
          this.releaseQueued = (result) => {
            result.then(resolve, reject);
          };
        });
      }
      return this.queued;
    }
    return this.start();
  }

  private start(): Promise<ReindexResult> {
    const current = reindex(this.deps).finally(() => {
      this.inFlight = null;
      const release = this.releaseQueued;
      if (release) {
        this.queued = null;
        this.releaseQueued = null;
        // Exactly one follow-up, however many requests coalesced into it.
        release(this.start());
      }
    });
    this.inFlight = current;
    return current;
  }
}
