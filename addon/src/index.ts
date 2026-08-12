import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import sdk from "stremio-addon-sdk";
import { RadarrClient, SonarrClient } from "./arr.js";
import { createCatalogHandler } from "./catalog.js";
import { CinemetaClient } from "./cinemeta.js";
import { loadConfig } from "./config.js";
import { MediaIndex } from "./db.js";
import { ReindexRunner } from "./indexer.js";
import { CACHE, manifest } from "./manifest.js";
import { createStreamHandler } from "./stream.js";
import type { Logger } from "./types.js";
import { consoleLogger, silentLogger } from "./types.js";

// The SDK is CommonJS with no detectable named exports — see the .d.ts.
const { addonBuilder, getRouter } = sdk;

export interface AppDeps {
  db: MediaIndex;
  publicBaseUrl: string;
  /** Empty token closes /admin/rescan entirely. */
  adminToken: string;
  /** Fire-and-forget: the route answers 202 without waiting for the rescan. */
  startRescan: () => void;
  logger?: Logger;
}

/**
 * N4 wants `Access-Control-Allow-Origin: *` on every route. getRouter already
 * applies CORS to the SDK's own routes, so this covers only the custom Express
 * routes it does not own (/health, /admin/rescan).
 */
function cors(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
}

/** Constant-time bearer comparison. An unset ADDON_ADMIN_TOKEN fails closed. */
function isAuthorized(authorization: string | undefined, token: string): boolean {
  if (token === "") return false;
  const prefix = "Bearer ";
  if (!authorization || !authorization.startsWith(prefix)) return false;

  const provided = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

export function createApp(deps: AppDeps): express.Express {
  const logger = deps.logger ?? silentLogger;
  const app = express();
  app.disable("x-powered-by");

  const builder = new addonBuilder(manifest);
  builder.defineCatalogHandler(createCatalogHandler(deps.db));
  builder.defineStreamHandler(
    createStreamHandler({ db: deps.db, publicBaseUrl: deps.publicBaseUrl }),
  );

  // The SDK router does not set a manifest cache header; 6.7 asks for one.
  app.get("/manifest.json", (_req, res, next) => {
    res.setHeader("Cache-Control", `max-age=${CACHE.manifestMaxAge}, public`);
    next();
  });

  // Preflight for the two custom routes; the SDK router answers its own.
  app.options(["/health", "/admin/rescan"], cors, (_req, res) => {
    res.sendStatus(204);
  });

  app.get("/health", cors, (_req, res) => {
    res.json({ count: deps.db.count() });
  });

  // Never routed through Caddy (5.2) and published on loopback only (section 4),
  // so this token guards the container network and a shell on the LXC.
  app.post("/admin/rescan", cors, (req, res) => {
    if (!isAuthorized(req.headers.authorization, deps.adminToken)) {
      logger.warn("admin: rescan rejected, missing or invalid bearer token");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    deps.startRescan();
    res.status(202).json({ status: "accepted" });
  });

  app.use(getRouter(builder.getInterface()));
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = consoleLogger;
  const db = new MediaIndex(config.dbPath);

  const radarr =
    config.radarrUrl && config.radarrApiKey
      ? new RadarrClient({ baseUrl: config.radarrUrl, apiKey: config.radarrApiKey, logger })
      : null;
  const sonarr =
    config.sonarrUrl && config.sonarrApiKey
      ? new SonarrClient({ baseUrl: config.sonarrUrl, apiKey: config.sonarrApiKey, logger })
      : null;

  const runner = new ReindexRunner({
    db,
    mediaRoot: config.mediaRoot,
    radarr,
    sonarr,
    cinemeta: new CinemetaClient(),
    logger,
  });

  const app = createApp({
    db,
    publicBaseUrl: config.publicBaseUrl,
    adminToken: config.adminToken,
    startRescan: () => {
      void runner.run().catch((error: unknown) => logger.error(`rescan failed: ${String(error)}`));
    },
    logger,
  });

  if (config.adminToken === "") {
    logger.warn("ADDON_ADMIN_TOKEN is not set — POST /admin/rescan will always answer 401");
  }
  if (!radarr) logger.warn("RADARR_URL/RADARR_API_KEY unset — movies rely on the Cinemeta fallback");
  if (!sonarr) logger.warn("SONARR_URL/SONARR_API_KEY unset — series rely on the Cinemeta fallback");
  if (config.publicBaseUrl.startsWith("http://")) {
    logger.warn(
      `PUBLIC_BASE_URL is plain HTTP (${config.publicBaseUrl}) — LAN mode. ` +
        "Stremio Desktop accepts it; Stremio Web and the mobile apps require HTTPS.",
    );
  }

  // Binding all interfaces is correct here: the container's port is published
  // on 127.0.0.1 only (section 4), which is what keeps /admin off the tailnet.
  const server = app.listen(config.port, () => {
    logger.info(`addon listening on :${config.port}, serving media from ${config.mediaRoot}`);
    logger.info(`stream URLs are built from ${config.publicBaseUrl}`);
  });

  // N5: the index is derived state, so it is rebuilt on every start.
  void runner.run().catch((error: unknown) => logger.error(`startup rescan failed: ${String(error)}`));

  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only start a server when executed directly; tests import createApp.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && path.resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  void main();
}
