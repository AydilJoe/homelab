import { normalizeTitle } from "./parser.js";
import type { FetchLike, MediaType } from "./types.js";

/**
 * Cinemeta fallback (6.3 step 2) — for files the *arrs do not know about,
 * typically manual drops.
 *
 * Accuracy for non-English titles is unvalidated (open item O1), which is why
 * the acceptance rule below is deliberately conservative: a wrong IMDb ID is
 * worse than an unmatched file, because an unmatched file is at least reported.
 */

export const CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";

export interface CinemetaMeta {
  id?: string;
  name?: string;
  type?: string;
  releaseInfo?: string | number;
  year?: string | number;
}

export interface CinemetaOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export interface ResolveQuery {
  title: string;
  year: number | null;
}

const IMDB_ID_RE = /^tt\d{6,}$/;
/** Release years drift by one between sources often enough to allow it. */
const YEAR_TOLERANCE = 1;

function firstYear(meta: CinemetaMeta): number | null {
  const raw = meta.releaseInfo ?? meta.year;
  if (raw === undefined || raw === null) return null;
  const match = /\d{4}/.exec(String(raw));
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Accept a match only when the normalised titles are identical AND either the
 * years agree within a year, or the file carried no year and exactly one
 * candidate has that title. Anything else is left unmatched.
 */
export function pickConfidentMatch(
  metas: CinemetaMeta[],
  query: ResolveQuery,
): CinemetaMeta | null {
  const wanted = normalizeTitle(query.title);
  if (wanted === "") return null;

  const sameTitle = metas.filter(
    (meta) =>
      typeof meta.id === "string" &&
      IMDB_ID_RE.test(meta.id) &&
      normalizeTitle(meta.name ?? "") === wanted,
  );
  if (sameTitle.length === 0) return null;

  const wantedYear = query.year;
  if (wantedYear === null) {
    return sameTitle.length === 1 ? (sameTitle[0] ?? null) : null;
  }

  const sameYear = sameTitle.filter((meta) => {
    const year = firstYear(meta);
    return year !== null && Math.abs(year - wantedYear) <= YEAR_TOLERANCE;
  });
  return sameYear.length === 1 ? (sameYear[0] ?? null) : null;
}

export class CinemetaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CinemetaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? CINEMETA_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async search(type: MediaType, query: string): Promise<CinemetaMeta[]> {
    const url = `${this.baseUrl}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
    const response = await this.fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`cinemeta responded ${response.status} for ${query}`);
    }
    const body = (await response.json()) as { metas?: CinemetaMeta[] } | null;
    return Array.isArray(body?.metas) ? body.metas : [];
  }

  /** Search + confidence filter. Returns the IMDb ID or null; never throws for "no match". */
  async resolve(type: MediaType, query: ResolveQuery): Promise<CinemetaMeta | null> {
    const metas = await this.search(type, query.title);
    return pickConfidentMatch(metas, query);
  }
}
