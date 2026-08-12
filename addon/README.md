# Local Library — Stremio addon

Serves the files already on the library disk to Stremio, as streams keyed by
IMDb ID. It returns URLs only: [Caddy](../caddy) serves the bytes and handles
Range requests, so seeking works and this process stays inside its 256 MB
ceiling (N6).

Built to spec section 6. Node 22, TypeScript, Express, `stremio-addon-sdk`,
better-sqlite3.

## How a file becomes a stream

1. Walk `MEDIA_ROOT` for `.mkv .mp4 .avi .m4v .webm`. (Only `MEDIA_ROOT` is
   mounted, so the torrents tree cannot be indexed even by accident.)
2. Ask Radarr once for every movie and Sonarr per series for every episode,
   and match their file paths onto the scanned files by path suffix — the
   mount prefixes do not have to agree.
3. Anything the *arrs do not know about is parsed with `parse-torrent-title`
   and looked up in Cinemeta's search catalog. Only a confident match counts:
   identical normalised title plus a year within one. Resolutions are cached in
   the index so the lookup happens once per file, not once per rescan.
4. Whatever is left lands in the `unmatched` table with a reason. Nothing is
   dropped silently.

Resolution and codec come from the filename only — there is no ffprobe — so
both columns are nullable and simply omitted from the stream description when
unknown.

A file holding several episodes (`S01E01E02`, `S01E01-E24`) becomes **one row
per episode sharing a `rel_path`** (6.4), on both the Sonarr route and the
filename-parsing route, so every episode it covers resolves to it. A span wider
than 100 episodes is treated as unparseable and the file goes to `unmatched`
with a reason rather than producing rows that would be wrong.

## Configuration

All configuration is environment variables; every one has a working default.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `7000` | Published on `127.0.0.1` by compose — do not loosen (6.5) |
| `MEDIA_ROOT` | `/data/media` | Read-only mount; `rel_path` is relative to it |
| `DB_PATH` | `/config/index.db` | Derived state, excluded from backups (N5, section 8) |
| `RADARR_URL` / `RADARR_API_KEY` | empty | Unset means movies fall back to Cinemeta |
| `SONARR_URL` / `SONARR_API_KEY` | empty | Unset means series fall back to Cinemeta |
| `ADDON_ADMIN_TOKEN` | empty | Bearer token for `/admin/rescan`; empty answers 401 to everything |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Baked into every stream URL |

`PUBLIC_BASE_URL` must be reachable from the Stremio **client**, not from
inside the container.

## LAN mode and the HTTPS limitation

The active default is LAN mode: Caddy serves plain HTTP on port 80 and
`PUBLIC_BASE_URL` is the LXC's LAN address, e.g. `http://192.168.1.50`.

**Stremio Desktop accepts a plain-HTTP addon and plain-HTTP stream URLs.
Stremio Web and the iOS/Android apps do not — they refuse mixed/insecure
content.** In LAN mode, install the addon in Stremio Desktop:

```
http://192.168.1.50/addon/manifest.json
```

Switching to the tailnet (spec section 5.2) is a `PUBLIC_BASE_URL` change plus
the TLS Caddyfile; the manifest URL becomes
`https://media.<tailnet>.ts.net/addon/manifest.json` and every client works.
Nothing in the addon itself needs a tailnet.

## Endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET | `/manifest.json` | manifest, `max-age=86400` |
| GET | `/catalog/:type/:id.json` | `{ metas }`, 100 per page |
| GET | `/catalog/:type/:id/:extra.json` | same, with `search=` / `skip=` |
| GET | `/stream/:type/:id.json` | `{ streams }` — empty list for an unknown id, never 404/500 |
| POST | `/admin/rescan` | 202 and reindexes asynchronously; 401 without `Authorization: Bearer $ADDON_ADMIN_TOKEN` |
| GET | `/health` | `{ "count": <rows in the index> }` |

Catalog and stream responses carry `cacheMaxAge` 3600 / `staleRevalidate` 7200
(6.7). There is no `meta` handler and there must never be one — IMDb IDs
delegate detail pages to Cinemeta (6.2).

`/admin/rescan` is blocked at Caddy and published on loopback only, so it is
reachable from the container network or a shell on the LXC and nowhere else.
The index rebuilds on startup anyway; the endpoint is for picking up a new
import without a restart.

### Duplicate qualities (decision O2)

When several files match one title or episode, **all** of them are returned as
separate streams, sorted best first: resolution descending, then size
descending. Stremio shows them as a list under one title.

## Development

```bash
npm install
npm test          # vitest, no network — the *arr and Cinemeta clients take an injected fetch
npm run typecheck # tsc over src AND test (see below); emits nothing
npm run dev       # tsx, reads the same environment variables
npm run build     # tsc -> dist/
npm start         # node dist/index.js
```

`npm run build` compiles `src/` only, so `dist/` mirrors it exactly. That leaves
the tests type-checked by nothing — vitest transpiles them with esbuild, which
strips types without checking them — so `npm run typecheck` uses
`tsconfig.test.json`, which covers both trees under the same strict options.

The container image is a multi-stage `node:22-alpine` build; better-sqlite3 is
compiled in the build stage and the runtime stage runs as the `node` user
(uid 1000, matching `PUID`/`PGID`).
