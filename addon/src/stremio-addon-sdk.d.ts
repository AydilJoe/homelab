/**
 * `stremio-addon-sdk` ships no type declarations. This covers only the surface
 * this addon uses: addonBuilder + getRouter.
 *
 * `defineMetaHandler` is deliberately absent — spec 6.2 forbids a meta handler
 * (detail-page metadata is delegated to Cinemeta via the IMDb ID), and leaving
 * it undeclared makes accidentally adding one a compile error.
 *
 * The package is CommonJS and its entry point is `module.exports = { … }` built
 * from require() calls, which Node's CJS named-export detection cannot see
 * through. Hence the default export: `import sdk from "stremio-addon-sdk"`
 * works under real Node ESM, `import { getRouter }` does not.
 */
declare module "stremio-addon-sdk" {
  import type { Router } from "express";

  export interface ManifestExtra {
    name: string;
    isRequired?: boolean;
    options?: string[];
    optionsLimit?: number;
  }

  export interface ManifestCatalog {
    type: string;
    id: string;
    name?: string;
    extra?: ManifestExtra[];
  }

  export interface Manifest {
    id: string;
    version: string;
    name: string;
    description?: string;
    resources: string[];
    types: string[];
    catalogs: ManifestCatalog[];
    idPrefixes?: string[];
    logo?: string;
    background?: string;
    contactEmail?: string;
    behaviorHints?: Record<string, unknown>;
  }

  /** Cache directives the SDK turns into a Cache-Control header (spec 6.7). */
  export interface CacheHints {
    cacheMaxAge?: number;
    staleRevalidate?: number;
    staleError?: number;
  }

  /**
   * The SDK builds `extra` with `querystring.parse` over the `/…/skip=100.json`
   * segment. That returns a string for a key seen once and an ARRAY for a key
   * that repeats (`?search=a&search=b`), so the array case is declared here —
   * treating these as plain strings is how `.trim() is not a function` reaches
   * a handler and turns into a 500.
   */
  export type ExtraArgs = Record<string, string | string[] | undefined>;

  export interface CatalogArgs {
    type: string;
    id: string;
    extra?: ExtraArgs;
  }

  export interface StreamArgs {
    type: string;
    id: string;
    extra?: ExtraArgs;
  }

  export interface MetaPreview {
    id: string;
    type: string;
    name: string;
    poster?: string;
    posterShape?: string;
    releaseInfo?: string;
    description?: string;
  }

  export interface StreamBehaviorHints {
    bingeGroup?: string;
    videoSize?: number;
    filename?: string;
    notWebReady?: boolean;
  }

  export interface Stream {
    name?: string;
    title?: string;
    description?: string;
    url?: string;
    behaviorHints?: StreamBehaviorHints;
  }

  export interface CatalogResult extends CacheHints {
    metas: MetaPreview[];
  }

  export interface StreamResult extends CacheHints {
    streams: Stream[];
  }

  export interface AddonInterface {
    manifest: Manifest;
  }

  export class addonBuilder {
    /** Throws if the manifest fails the SDK's own schema validation. */
    constructor(manifest: Manifest);
    defineCatalogHandler(handler: (args: CatalogArgs) => Promise<CatalogResult>): void;
    defineStreamHandler(handler: (args: StreamArgs) => Promise<StreamResult>): void;
    /** Throws if a resource declared in the manifest has no handler. */
    getInterface(): AddonInterface;
  }

  /** Express router serving /manifest.json and the resource routes. Applies CORS itself. */
  export function getRouter(addonInterface: AddonInterface): Router;

  const sdk: {
    addonBuilder: typeof addonBuilder;
    getRouter: typeof getRouter;
  };
  export default sdk;
}
