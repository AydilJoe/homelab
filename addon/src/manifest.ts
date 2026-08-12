import type { Manifest } from "stremio-addon-sdk";
import type { MediaType } from "./types.js";

/**
 * Manifest, spec section 6.2 verbatim.
 *
 * `resources` deliberately omits "meta": IMDb IDs delegate detail-page metadata
 * to Cinemeta, so there is nothing to maintain here. Do not add one.
 *
 * The key set is exactly 6.2's and nothing else — no `description`, no `logo`.
 * test/app.test.ts asserts the served manifest against an inline copy of the
 * spec's JSON literal (not against this object), so any drift is a test
 * failure rather than something both sides agree on.
 */
export const manifest: Manifest = {
  id: "com.codyl.localmedia",
  version: "1.0.0",
  name: "Local Library",
  resources: ["catalog", "stream"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "local-movies",
      name: "Local Films",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "local-series",
      name: "Local Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  idPrefixes: ["tt"],
};

/** Catalog id -> the media type it serves. */
export const CATALOG_TYPES: Record<string, MediaType> = {
  "local-movies": "movie",
  "local-series": "series",
};

/** Cache directives from spec 6.7. */
export const CACHE = {
  manifestMaxAge: 86400,
  catalog: { cacheMaxAge: 3600, staleRevalidate: 7200 },
  stream: { cacheMaxAge: 3600, staleRevalidate: 7200 },
} as const;
