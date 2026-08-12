import type { FetchLike, Logger, MediaType } from "./types.js";
import { silentLogger } from "./types.js";

/**
 * Radarr and Sonarr clients — the primary identifier source (6.3). Local,
 * deterministic, no rate limits.
 *
 * Sonarr episode numbers come from /api/v3/episode, never from
 * /api/v3/episodefile: that endpoint carries no episode numbers and rejects
 * parameterless bulk GETs.
 */

/** One (file, episode) pair the *arrs can name. Movies use season 0 / episode 0. */
export interface ArrMatch {
  imdbId: string;
  type: MediaType;
  season: number;
  episode: number;
  title: string;
  year: number | null;
  /** Path as the *arr reports it — an absolute path in ITS mount namespace. */
  path: string;
  matchSource: "radarr" | "sonarr";
}

export interface ArrClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  logger?: Logger;
}

interface RadarrMovieFile {
  path?: string;
  relativePath?: string;
}

interface RadarrMovie {
  id?: number;
  title?: string;
  year?: number;
  imdbId?: string;
  path?: string;
  hasFile?: boolean;
  movieFile?: RadarrMovieFile;
}

interface SonarrSeries {
  id?: number;
  title?: string;
  year?: number;
  imdbId?: string;
  path?: string;
}

interface SonarrEpisodeFile {
  path?: string;
  relativePath?: string;
}

interface SonarrEpisode {
  seriesId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  hasFile?: boolean;
  episodeFileId?: number;
  episodeFile?: SonarrEpisodeFile;
}

/** How many series to ask Sonarr about at once. Keeps a 5,000-file rescan inside N3. */
const SERIES_CONCURRENCY = 4;

function joinPath(base: string | undefined, relative: string | undefined): string | undefined {
  if (!base || !relative) return undefined;
  return `${base.replace(/[/\\]+$/, "")}/${relative.replace(/^[/\\]+/, "")}`;
}

function toYear(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<R[]>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    const batch = items.slice(index, index + size);
    const settled = await Promise.all(batch.map(worker));
    for (const part of settled) results.push(...part);
  }
  return results;
}

abstract class ArrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  protected readonly logger: Logger;

  constructor(options: ArrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.logger = options.logger ?? silentLogger;
  }

  protected async getJson<T>(pathAndQuery: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
      method: "GET",
      headers: { "X-Api-Key": this.apiKey, accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`${this.baseUrl}${pathAndQuery} responded ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

export class RadarrClient extends ArrClient {
  /** One bulk call returns imdbId and the file path for every movie (6.3). */
  async collectMatches(): Promise<ArrMatch[]> {
    const movies = await this.getJson<RadarrMovie[]>("/api/v3/movie");
    if (!Array.isArray(movies)) return [];

    const matches: ArrMatch[] = [];
    for (const movie of movies) {
      const imdbId = movie.imdbId?.trim();
      const filePath = movie.movieFile?.path ?? joinPath(movie.path, movie.movieFile?.relativePath);
      if (!imdbId || !filePath) continue;

      matches.push({
        imdbId,
        type: "movie",
        season: 0,
        episode: 0,
        title: movie.title?.trim() || imdbId,
        year: toYear(movie.year),
        path: filePath,
        matchSource: "radarr",
      });
    }
    return matches;
  }
}

export class SonarrClient extends ArrClient {
  /**
   * Series-level imdbId, then per-series episodes with their files. A
   * multi-episode file is simply several episodes sharing one episodeFileId —
   * they each become a match against the same path, which is where the
   * one-row-per-episode fan-out of 6.4 comes from.
   *
   * Series that Sonarr has no imdbId for produce no matches here and fall
   * through to the Cinemeta path in the indexer (6.3).
   */
  async collectMatches(): Promise<ArrMatch[]> {
    const allSeries = await this.getJson<SonarrSeries[]>("/api/v3/series");
    if (!Array.isArray(allSeries)) return [];

    const usable = allSeries.filter(
      (series) => typeof series.id === "number" && (series.imdbId ?? "").trim() !== "",
    );

    return inBatches(usable, SERIES_CONCURRENCY, async (series) => {
      try {
        return await this.matchesForSeries(series);
      } catch (error) {
        // One unreachable series must not sink the whole rescan.
        this.logger.warn(`sonarr: episodes for series ${series.id} failed: ${String(error)}`);
        return [];
      }
    });
  }

  private async matchesForSeries(series: SonarrSeries): Promise<ArrMatch[]> {
    const episodes = await this.getJson<SonarrEpisode[]>(
      `/api/v3/episode?seriesId=${series.id}&includeEpisodeFile=true`,
    );
    if (!Array.isArray(episodes)) return [];

    const imdbId = (series.imdbId ?? "").trim();
    const matches: ArrMatch[] = [];

    for (const episode of episodes) {
      if (episode.hasFile === false) continue;
      if (typeof episode.seasonNumber !== "number" || typeof episode.episodeNumber !== "number") {
        continue;
      }
      const filePath =
        episode.episodeFile?.path ?? joinPath(series.path, episode.episodeFile?.relativePath);
      if (!filePath) continue;

      matches.push({
        imdbId,
        type: "series",
        season: episode.seasonNumber,
        episode: episode.episodeNumber,
        title: series.title?.trim() || imdbId,
        year: toYear(series.year),
        path: filePath,
        matchSource: "sonarr",
      });
    }
    return matches;
  }
}
