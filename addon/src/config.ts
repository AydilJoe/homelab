/** Environment configuration. Every value has a default that works in the compose stack. */

export interface Config {
  port: number;
  /** Read-only mount of the library root; rel_path is relative to this. */
  mediaRoot: string;
  dbPath: string;
  radarrUrl: string;
  sonarrUrl: string;
  radarrApiKey: string;
  sonarrApiKey: string;
  /** Bearer token for POST /admin/rescan. Empty means the route is closed. */
  adminToken: string;
  /**
   * Base URL baked into every stream URL. Must be reachable from the Stremio
   * CLIENT, not from inside the container.
   *   LAN mode:     http://192.168.1.50   (Stremio Desktop only — see README)
   *   Tailnet mode: https://media.<tailnet>.ts.net
   */
  publicBaseUrl: string;
}

const DEFAULT_PORT = 7000;
const DEFAULT_MEDIA_ROOT = "/data/media";
const DEFAULT_DB_PATH = "/config/index.db";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsedPort = Number.parseInt(env.PORT ?? "", 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

  return {
    port,
    mediaRoot: env.MEDIA_ROOT?.trim() || DEFAULT_MEDIA_ROOT,
    dbPath: env.DB_PATH?.trim() || DEFAULT_DB_PATH,
    radarrUrl: trimTrailingSlash(env.RADARR_URL?.trim() ?? ""),
    sonarrUrl: trimTrailingSlash(env.SONARR_URL?.trim() ?? ""),
    radarrApiKey: env.RADARR_API_KEY?.trim() ?? "",
    sonarrApiKey: env.SONARR_API_KEY?.trim() ?? "",
    adminToken: env.ADDON_ADMIN_TOKEN?.trim() ?? "",
    publicBaseUrl: trimTrailingSlash(env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`),
  };
}
