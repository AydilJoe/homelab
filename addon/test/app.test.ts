import request from "supertest";
import sdk from "stremio-addon-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RadarrClient } from "../src/arr.js";
import { MediaIndex } from "../src/db.js";
import { createApp } from "../src/index.js";
import { reindex, type ReindexResult } from "../src/indexer.js";
import { manifest } from "../src/manifest.js";
import { silentLogger } from "../src/types.js";
import { createFetchStub, createFixture, mediaRow, type Fixture } from "./helpers.js";

const ADMIN_TOKEN = "test-token-9f2c";
const MOVIE_FILE = "movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264.mkv";

/**
 * Spec 6.2's manifest literal, transcribed here on purpose.
 *
 * Comparing the HTTP response against `manifest` (the module's own export)
 * would pass for any manifest the addon happens to serve — the two sides would
 * simply agree with each other. Keeping an independent copy is what makes
 * "manifest matches 6.2 exactly" an actual assertion: adding a key to
 * src/manifest.ts fails this test.
 */
const SPEC_MANIFEST = {
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

describe("http surface", () => {
  let fixture: Fixture;
  let db: MediaIndex;
  let rescans: Array<Promise<ReindexResult>>;

  beforeEach(() => {
    fixture = createFixture({});
    db = new MediaIndex(fixture.dbPath);
    rescans = [];
    db.replaceAll(
      [
        mediaRow(),
        mediaRow({
          imdb_id: "tt0133093",
          title: "The Matrix",
          year: 1999,
          rel_path: "movies/The Matrix (1999)/The.Matrix.1999.1080p.mkv",
        }),
        mediaRow({
          imdb_id: "tt7777777",
          type: "series",
          season: 1,
          episode: 2,
          title: "Some Show",
          rel_path: "tv/Some Show/S01E02.mkv",
          match_source: "sonarr",
        }),
      ],
      [],
    );
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  function app() {
    return createApp({
      db,
      publicBaseUrl: "http://192.168.1.50",
      adminToken: ADMIN_TOKEN,
      startRescan: () => {
        rescans.push(Promise.resolve({ files: 0, rows: db.count(), unmatched: 0, durationMs: 0 }));
      },
      logger: silentLogger,
    });
  }

  describe("manifest", () => {
    it("serves the manifest and it validates against the SDK schema", async () => {
      const response = await request(app()).get("/manifest.json").expect(200);

      // Against the spec literal, not against our own export (see SPEC_MANIFEST).
      expect(response.body).toEqual(SPEC_MANIFEST);
      expect(Object.keys(response.body).sort()).toEqual(Object.keys(SPEC_MANIFEST).sort());
      expect(manifest).toEqual(SPEC_MANIFEST);
      // The SDK's constructor throws on anything its schema rejects.
      expect(() => new sdk.addonBuilder(response.body)).not.toThrow();
      expect(response.body.resources).toEqual(["catalog", "stream"]);
      // Spec 6.2: no meta handler, ever.
      expect(response.body.resources).not.toContain("meta");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["cache-control"]).toContain("max-age=86400");
    });
  });

  describe("catalog", () => {
    it("returns metas with metahub posters and the 6.7 cache hints", async () => {
      const response = await request(app()).get("/catalog/movie/local-movies.json").expect(200);

      expect(response.body.metas).toEqual([
        {
          id: "tt0133093",
          type: "movie",
          name: "The Matrix",
          poster: "https://images.metahub.space/poster/small/tt0133093/img",
        },
        {
          id: "tt0111161",
          type: "movie",
          name: "The Shawshank Redemption",
          poster: "https://images.metahub.space/poster/small/tt0111161/img",
        },
      ]);
      expect(response.headers["cache-control"]).toContain("max-age=3600");
      expect(response.headers["cache-control"]).toContain("stale-while-revalidate=7200");
    });

    it("filters on the search extra", async () => {
      const response = await request(app())
        .get("/catalog/movie/local-movies/search=shawshank.json")
        .expect(200);

      expect(response.body.metas).toHaveLength(1);
      expect(response.body.metas[0].id).toBe("tt0111161");
    });

    it("pages on the skip extra", async () => {
      const response = await request(app())
        .get("/catalog/movie/local-movies/skip=1.json")
        .expect(200);

      expect(response.body.metas).toHaveLength(1);
      expect(response.body.metas[0].id).toBe("tt0111161");
    });

    it("survives a repeated extra key — 200, never 500", async () => {
      // The SDK parses the extra segment with querystring.parse, which returns
      // an ARRAY when a key repeats. Anything reachable from any origin
      // (ACAO *) must not be able to produce a 500 (6.9).
      const response = await request(app())
        .get("/catalog/movie/local-movies/search=shawshank&search=matrix.json")
        .expect(200);

      expect(response.body.metas).toHaveLength(1);
      expect(response.body.metas[0].id).toBe("tt0111161");
    });

    it("survives a repeated skip key", async () => {
      const response = await request(app())
        .get("/catalog/movie/local-movies/skip=1&skip=2.json")
        .expect(200);
      expect(response.body.metas).toHaveLength(1);
    });

    it("serves the series catalog separately", async () => {
      const response = await request(app()).get("/catalog/series/local-series.json").expect(200);
      expect(response.body.metas.map((meta: { id: string }) => meta.id)).toEqual(["tt7777777"]);
    });
  });

  describe("stream", () => {
    it("returns the local file for a known id", async () => {
      const response = await request(app()).get("/stream/movie/tt0133093.json").expect(200);

      expect(response.body.streams).toHaveLength(1);
      expect(response.body.streams[0]).toMatchObject({
        name: "Local",
        url: "http://192.168.1.50/media/movies/The%20Matrix%20(1999)/The.Matrix.1999.1080p.mkv",
        behaviorHints: { bingeGroup: "local-tt0133093" },
      });
    });

    it("returns an empty list for an unknown id — not 404, not 500", async () => {
      const response = await request(app()).get("/stream/movie/tt9999999.json").expect(200);
      expect(response.body).toMatchObject({ streams: [] });
    });

    it("returns an empty list for a malformed series id", async () => {
      const response = await request(app()).get("/stream/series/tt1234567:x:y.json").expect(200);
      expect(response.body).toMatchObject({ streams: [] });
    });
  });

  describe("GET /health", () => {
    it("reports the index row count with CORS applied", async () => {
      const response = await request(app()).get("/health").expect(200);
      expect(response.body).toEqual({ count: 3 });
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    });

    it("answers a CORS preflight on the custom routes (N4)", async () => {
      const response = await request(app()).options("/admin/rescan").expect(204);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("POST /admin/rescan", () => {
    it("rejects a request with no token", async () => {
      await request(app()).post("/admin/rescan").expect(401);
      expect(rescans).toHaveLength(0);
    });

    it("rejects a wrong token and a malformed header", async () => {
      await request(app()).post("/admin/rescan").set("Authorization", "Bearer nope").expect(401);
      await request(app()).post("/admin/rescan").set("Authorization", ADMIN_TOKEN).expect(401);
      await request(app()).post("/admin/rescan").set("Authorization", "Basic abc").expect(401);
      expect(rescans).toHaveLength(0);
    });

    it("accepts a valid token with 202 and reindexes asynchronously", async () => {
      const response = await request(app())
        .post("/admin/rescan")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
        .expect(202);

      expect(response.body).toEqual({ status: "accepted" });
      expect(rescans).toHaveLength(1);
    });

    it("answers 401 when no admin token is configured at all", async () => {
      const closed = createApp({
        db,
        publicBaseUrl: "http://192.168.1.50",
        adminToken: "",
        startRescan: () => rescans.push(Promise.resolve({ files: 0, rows: 0, unmatched: 0, durationMs: 0 })),
        logger: silentLogger,
      });
      await request(closed).post("/admin/rescan").set("Authorization", "Bearer ").expect(401);
      expect(rescans).toHaveLength(0);
    });
  });
});

describe("POST /admin/rescan is idempotent", () => {
  let fixture: Fixture;
  let db: MediaIndex;

  beforeEach(() => {
    fixture = createFixture({ [MOVIE_FILE]: 4096, "movies/Loose.File.2001.720p.mkv": 512 });
    db = new MediaIndex(fixture.dbPath);
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  it("leaves identical row counts after two runs", async () => {
    const stub = createFetchStub([
      [
        "/api/v3/movie",
        [
          {
            id: 1,
            title: "The Matrix",
            year: 1999,
            imdbId: "tt0133093",
            hasFile: true,
            movieFile: { path: `/data/media/${MOVIE_FILE}` },
          },
        ],
      ],
    ]);

    const pending: Array<Promise<ReindexResult>> = [];
    const app = createApp({
      db,
      publicBaseUrl: "http://192.168.1.50",
      adminToken: ADMIN_TOKEN,
      startRescan: () => {
        pending.push(
          reindex({
            db,
            mediaRoot: fixture.mediaRoot,
            radarr: new RadarrClient({ baseUrl: "http://radarr:7878", apiKey: "x", fetchImpl: stub.fetch }),
            logger: silentLogger,
          }),
        );
      },
      logger: silentLogger,
    });

    await request(app).post("/admin/rescan").set("Authorization", `Bearer ${ADMIN_TOKEN}`).expect(202);
    const firstRun = await pending[0]!;
    const firstRows = db.allMedia();

    await request(app).post("/admin/rescan").set("Authorization", `Bearer ${ADMIN_TOKEN}`).expect(202);
    const secondRun = await pending[1]!;

    expect(secondRun.rows).toBe(firstRun.rows);
    expect(secondRun.unmatched).toBe(firstRun.unmatched);
    expect(db.allMedia()).toEqual(firstRows);

    const health = await request(app).get("/health").expect(200);
    expect(health.body.count).toBe(firstRun.rows);
  });
});
