import type { CatalogArgs, CatalogResult, MetaPreview } from "stremio-addon-sdk";
import type { MediaIndex } from "./db.js";
import { CACHE, CATALOG_TYPES } from "./manifest.js";
import type { CatalogRow } from "./types.js";

/** Stremio pages catalogs in hundreds; `skip` arrives as a multiple of this. */
export const CATALOG_PAGE_SIZE = 100;

/**
 * Catalog tiles are the one place Cinemeta does not help — the addon has to
 * supply the poster itself (6.2). Metahub serves one per IMDb ID, so no posters
 * are stored locally.
 */
export function posterUrl(imdbId: string): string {
  return `https://images.metahub.space/poster/small/${imdbId}/img`;
}

function toMeta(row: CatalogRow): MetaPreview {
  return {
    id: row.imdb_id,
    type: row.type,
    name: row.title,
    poster: posterUrl(row.imdb_id),
  };
}

/**
 * The SDK parses the `/…/search=a&skip=100.json` segment with
 * `querystring.parse`, which yields a STRING for one occurrence of a key and an
 * ARRAY when it repeats. `?search=a&search=b` is reachable by anyone, so every
 * extra value is normalised here — the DB layer must never receive an array.
 */
function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : undefined;
}

function parseSkip(value: string | string[] | undefined): number {
  const parsed = Number.parseInt(firstValue(value) ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function createCatalogHandler(db: MediaIndex) {
  return async function catalogHandler(args: CatalogArgs): Promise<CatalogResult> {
    const type = CATALOG_TYPES[args.id];
    // Unknown catalog id, or an id/type pair that disagrees: empty, not an error.
    if (!type || type !== args.type) {
      return { metas: [], ...CACHE.catalog };
    }

    const rows = db.catalog({
      type,
      search: firstValue(args.extra?.search),
      skip: parseSkip(args.extra?.skip),
      limit: CATALOG_PAGE_SIZE,
    });

    return { metas: rows.map(toMeta), ...CACHE.catalog };
  };
}
