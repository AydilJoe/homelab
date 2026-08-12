import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RadarrClient, SonarrClient } from "../src/arr.js";
import { CinemetaClient } from "../src/cinemeta.js";
import { MediaIndex } from "../src/db.js";
import { MediaRootUnreadableError, ReindexRunner, matchRelPath, reindex, scanMediaRoot } from "../src/indexer.js";
import { silentLogger } from "../src/types.js";
import { createFetchStub, createFixture, type Fixture } from "./helpers.js";

const MOVIE_FILE = "movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264.mkv";
const MULTI_EPISODE_FILE = "tv/Some Show/Season 01/Some.Show.S01E01E02.1080p.WEB-DL.H.264.mkv";
const SINGLE_EPISODE_FILE = "tv/Some Show/Season 01/Some.Show.S01E03.1080p.WEB-DL.H.264.mkv";

/** The *arrs report absolute paths from THEIR mount, which need not match ours. */
const ARR_PREFIX = "/data/media";

function radarrPayload() {
  return [
    {
      id: 1,
      title: "The Matrix",
      year: 1999,
      imdbId: "tt0133093",
      hasFile: true,
      movieFile: { path: `${ARR_PREFIX}/${MOVIE_FILE}` },
    },
    // A movie Radarr knows about but whose file is not on this disk.
    { id: 2, title: "Elsewhere", year: 2001, imdbId: "tt0000002", hasFile: true, movieFile: { path: "/other/library/Elsewhere.mkv" } },
  ];
}

function sonarrSeriesPayload() {
  return [{ id: 7, title: "Some Show", year: 2015, imdbId: "tt7777777", path: `${ARR_PREFIX}/tv/Some Show` }];
}

function sonarrEpisodesPayload() {
  // Episodes 1 and 2 share one episodeFileId — a multi-episode file.
  return [
    {
      seriesId: 7,
      seasonNumber: 1,
      episodeNumber: 1,
      hasFile: true,
      episodeFileId: 42,
      episodeFile: { path: `${ARR_PREFIX}/${MULTI_EPISODE_FILE}` },
    },
    {
      seriesId: 7,
      seasonNumber: 1,
      episodeNumber: 2,
      hasFile: true,
      episodeFileId: 42,
      episodeFile: { path: `${ARR_PREFIX}/${MULTI_EPISODE_FILE}` },
    },
    {
      seriesId: 7,
      seasonNumber: 1,
      episodeNumber: 3,
      hasFile: true,
      episodeFileId: 43,
      episodeFile: { path: `${ARR_PREFIX}/${SINGLE_EPISODE_FILE}` },
    },
    { seriesId: 7, seasonNumber: 1, episodeNumber: 4, hasFile: false, episodeFileId: 0 },
  ];
}

describe("scanMediaRoot", () => {
  let fixture: Fixture;
  afterEach(() => fixture.cleanup());

  it("finds video files recursively and ignores everything else", async () => {
    fixture = createFixture({
      [MOVIE_FILE]: 1024,
      "movies/The Matrix (1999)/The.Matrix.1999.nfo": 10,
      "movies/The Matrix (1999)/The.Matrix.1999.en.srt": 10,
      "movies/.hidden.mkv": 10,
      "clips/clip.mp4": 32,
      "clips/clip.avi": 32,
      "clips/clip.m4v": 32,
      "clips/clip.webm": 32,
    });

    const files = await scanMediaRoot(fixture.mediaRoot, silentLogger);
    expect(files.map((file) => file.rel_path)).toEqual([
      "clips/clip.avi",
      "clips/clip.m4v",
      "clips/clip.mp4",
      "clips/clip.webm",
      MOVIE_FILE,
    ]);
    expect(files[4]?.size_bytes).toBe(1024);
  });

  it("only ever walks MEDIA_ROOT, so the torrents tree cannot be indexed", async () => {
    fixture = createFixture({ [MOVIE_FILE]: 8 });
    // A sibling of the media root, exactly as /srv/data is laid out (section 3.2).
    const torrents = path.join(fixture.root, "torrents", "movies");
    fs.mkdirSync(torrents, { recursive: true });
    fs.writeFileSync(path.join(torrents, "Something.Downloading.mkv"), Buffer.alloc(8));

    const files = await scanMediaRoot(fixture.mediaRoot, silentLogger);
    expect(files.map((file) => file.rel_path)).toEqual([MOVIE_FILE]);
  });
});

describe("matchRelPath", () => {
  const scanned = new Map([
    [MOVIE_FILE, { rel_path: MOVIE_FILE, size_bytes: 1, mtime: 1 }],
    ["Loose.mkv", { rel_path: "Loose.mkv", size_bytes: 1, mtime: 1 }],
  ]);

  it("matches across differing mount prefixes", () => {
    expect(matchRelPath(`/srv/data/media/${MOVIE_FILE}`, scanned)).toBe(MOVIE_FILE);
    expect(matchRelPath(`/media/${MOVIE_FILE}`, scanned)).toBe(MOVIE_FILE);
    expect(matchRelPath(`C:\\library\\${MOVIE_FILE.replace(/\//g, "\\")}`, scanned)).toBe(MOVIE_FILE);
  });

  it("returns null for a file this container cannot see", () => {
    expect(matchRelPath("/other/library/Elsewhere.mkv", scanned)).toBeNull();
  });
});

describe("reindex", () => {
  let fixture: Fixture;
  let db: MediaIndex;

  beforeEach(() => {
    fixture = createFixture({
      [MOVIE_FILE]: 4096,
      [MULTI_EPISODE_FILE]: 2048,
      [SINGLE_EPISODE_FILE]: 1024,
    });
    db = new MediaIndex(fixture.dbPath);
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  function arrClients() {
    const stub = createFetchStub([
      ["/api/v3/movie", radarrPayload()],
      ["/api/v3/episode", sonarrEpisodesPayload()],
      ["/api/v3/series", sonarrSeriesPayload()],
    ]);
    return {
      stub,
      radarr: new RadarrClient({ baseUrl: "http://radarr:7878", apiKey: "x", fetchImpl: stub.fetch }),
      sonarr: new SonarrClient({ baseUrl: "http://sonarr:8989", apiKey: "x", fetchImpl: stub.fetch }),
    };
  }

  it("resolves movies through Radarr, matching on path suffix", async () => {
    const { radarr, sonarr } = arrClients();
    await reindex({ db, mediaRoot: fixture.mediaRoot, radarr, sonarr, logger: silentLogger });

    const rows = db.streamsFor("tt0133093", 0, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "movie",
      season: 0,
      episode: 0,
      rel_path: MOVIE_FILE,
      size_bytes: 4096,
      resolution: "1080p",
      video_codec: "H.264",
      match_source: "radarr",
      title: "The Matrix",
      year: 1999,
    });
  });

  it("fans a multi-episode file out to one row per episode sharing rel_path", async () => {
    const { radarr, sonarr } = arrClients();
    await reindex({ db, mediaRoot: fixture.mediaRoot, radarr, sonarr, logger: silentLogger });

    const first = db.streamsFor("tt7777777", 1, 1);
    const second = db.streamsFor("tt7777777", 1, 2);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.rel_path).toBe(MULTI_EPISODE_FILE);
    expect(second[0]?.rel_path).toBe(MULTI_EPISODE_FILE);
    expect(first[0]?.match_source).toBe("sonarr");

    // The single-episode file is untouched by the fan-out.
    expect(db.streamsFor("tt7777777", 1, 3)).toHaveLength(1);
    // Episode 4 has no file at all.
    expect(db.streamsFor("tt7777777", 1, 4)).toEqual([]);
  });

  it("fans a multi-episode file out on the Cinemeta path too, sharing one rel_path", async () => {
    // The *arr path gets its episode numbers from Sonarr; the fallback path has
    // to derive them from the filename, so 6.9's one-row-per-episode rule has
    // to hold on both routes.
    const stub = createFetchStub([
      ["search=", { metas: [{ id: "tt7777777", name: "Some Show", type: "series", releaseInfo: "2015" }] }],
    ]);
    await reindex({
      db,
      mediaRoot: fixture.mediaRoot,
      cinemeta: new CinemetaClient({ fetchImpl: stub.fetch }),
      logger: silentLogger,
    });

    const first = db.streamsFor("tt7777777", 1, 1);
    const second = db.streamsFor("tt7777777", 1, 2);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // One row per episode, both pointing at the same file on disk (6.4).
    expect(first[0]?.rel_path).toBe(MULTI_EPISODE_FILE);
    expect(second[0]?.rel_path).toBe(MULTI_EPISODE_FILE);
    expect(first[0]?.match_source).toBe("cinemeta");
    expect(second[0]?.episode).toBe(2);
  });

  it("indexes a season pack as one row per episode, not just its endpoints", async () => {
    // Regression guard at the row level for the S01E01-E24 parser bug.
    const pack = "tv/Some Show/Season 02/Some.Show.S02E01-E24.1080p.mkv";
    const packFixture = createFixture({ [pack]: 8192 });
    const packDb = new MediaIndex(packFixture.dbPath);
    const stub = createFetchStub([
      ["search=", { metas: [{ id: "tt7777777", name: "Some Show", type: "series", releaseInfo: "2015" }] }],
    ]);

    await reindex({
      db: packDb,
      mediaRoot: packFixture.mediaRoot,
      cinemeta: new CinemetaClient({ fetchImpl: stub.fetch }),
      logger: silentLogger,
    });

    expect(packDb.count()).toBe(24);
    const episodes = packDb.allMedia().map((row) => row.episode);
    expect(episodes).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    // Every row is the same file.
    expect(new Set(packDb.allMedia().map((row) => row.rel_path)).size).toBe(1);

    packDb.close();
    packFixture.cleanup();
  });

  it("records files nothing could resolve instead of dropping them", async () => {
    const stub = createFetchStub([["search=", { metas: [] }]]);
    await reindex({
      db,
      mediaRoot: fixture.mediaRoot,
      cinemeta: new CinemetaClient({ fetchImpl: stub.fetch }),
      logger: silentLogger,
      now: () => 1_700_000_000,
    });

    expect(db.count()).toBe(0);
    const unmatched = db.allUnmatched();
    expect(unmatched).toHaveLength(3);
    expect(unmatched.map((row) => row.rel_path)).toContain(MOVIE_FILE);
    expect(unmatched[0]?.seen_at).toBe(1_700_000_000);
    expect(unmatched[0]?.reason).toMatch(/cinemeta/);
  });

  it("falls back to Cinemeta and caches the resolution in the DB", async () => {
    const stub = createFetchStub([
      ["search=", { metas: [{ id: "tt0133093", name: "The Matrix", type: "movie", releaseInfo: "1999" }] }],
    ]);
    const cinemeta = new CinemetaClient({ fetchImpl: stub.fetch });
    const deps = { db, mediaRoot: fixture.mediaRoot, cinemeta, logger: silentLogger };

    await reindex(deps);
    const rows = db.streamsFor("tt0133093", 0, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.match_source).toBe("cinemeta");

    const matrixLookups = (): number => stub.calls.filter((url) => url.includes("Matrix")).length;
    expect(matrixLookups()).toBe(1);

    await reindex(deps);
    // The second run reuses the cached resolution: one network lookup per file
    // ever, not one per rescan (6.3).
    expect(matrixLookups()).toBe(1);
    expect(db.streamsFor("tt0133093", 0, 0)).toHaveLength(1);
  });

  it("is idempotent — two runs leave identical rows", async () => {
    const first = arrClients();
    const firstResult = await reindex({
      db,
      mediaRoot: fixture.mediaRoot,
      radarr: first.radarr,
      sonarr: first.sonarr,
      logger: silentLogger,
    });
    const firstRows = db.allMedia();

    const second = arrClients();
    const secondResult = await reindex({
      db,
      mediaRoot: fixture.mediaRoot,
      radarr: second.radarr,
      sonarr: second.sonarr,
      logger: silentLogger,
    });

    expect(secondResult.rows).toBe(firstResult.rows);
    expect(secondResult.unmatched).toBe(firstResult.unmatched);
    expect(db.allMedia()).toEqual(firstRows);
  });

  it("refuses to replace the index when the media root cannot be read", async () => {
    // The container start-up rescan runs on EVERY start. A bind mount that is
    // not ready yet must not be mistaken for "the library is empty" — that
    // would wipe every media row and the cached Cinemeta resolutions 6.3
    // exists to preserve.
    const stub = createFetchStub([
      ["search=", { metas: [{ id: "tt0133093", name: "The Matrix", type: "movie", releaseInfo: "1999" }] }],
    ]);
    const cinemeta = new CinemetaClient({ fetchImpl: stub.fetch });
    await reindex({ db, mediaRoot: fixture.mediaRoot, cinemeta, logger: silentLogger });
    const before = db.allMedia();
    expect(before.length).toBeGreaterThan(0);
    expect(db.cachedCinemetaResolutions().size).toBeGreaterThan(0);

    const result = await reindex({
      db,
      mediaRoot: path.join(fixture.root, "does-not-exist"),
      cinemeta,
      logger: silentLogger,
    });

    expect(result.aborted).toBeTruthy();
    expect(result.rows).toBe(before.length);
    expect(db.allMedia()).toEqual(before);
    expect(db.cachedCinemetaResolutions().size).toBeGreaterThan(0);
  });

  it("refuses to empty a non-empty index from a readable but empty media root", async () => {
    const stub = createFetchStub([
      ["search=", { metas: [{ id: "tt0133093", name: "The Matrix", type: "movie", releaseInfo: "1999" }] }],
    ]);
    const cinemeta = new CinemetaClient({ fetchImpl: stub.fetch });
    await reindex({ db, mediaRoot: fixture.mediaRoot, cinemeta, logger: silentLogger });
    const before = db.count();
    expect(before).toBeGreaterThan(0);

    const empty = path.join(fixture.root, "empty-media");
    fs.mkdirSync(empty, { recursive: true });

    const guarded = await reindex({ db, mediaRoot: empty, cinemeta, logger: silentLogger });
    expect(guarded.aborted).toBeTruthy();
    expect(db.count()).toBe(before);

    // ...but an explicit allowEmpty still empties it, for a library that
    // really was cleared.
    const forced = await reindex({ db, mediaRoot: empty, cinemeta, allowEmpty: true, logger: silentLogger });
    expect(forced.aborted).toBeUndefined();
    expect(db.count()).toBe(0);
  });

  it("scanMediaRoot throws for a missing root but tolerates an unreadable subtree", async () => {
    await expect(scanMediaRoot(path.join(fixture.root, "nope"), silentLogger)).rejects.toBeInstanceOf(
      MediaRootUnreadableError,
    );
  });

  it("keeps working when an *arr is unreachable", async () => {
    const stub = createFetchStub([]); // every call 404s
    const radarr = new RadarrClient({ baseUrl: "http://radarr:7878", apiKey: "x", fetchImpl: stub.fetch });
    const result = await reindex({ db, mediaRoot: fixture.mediaRoot, radarr, logger: silentLogger });

    expect(result.files).toBe(3);
    expect(result.rows).toBe(0);
    expect(result.unmatched).toBe(3);
  });
});

describe("ReindexRunner", () => {
  let fixture: Fixture;
  let db: MediaIndex;

  beforeEach(() => {
    fixture = createFixture({ [MOVIE_FILE]: 4096 });
    db = new MediaIndex(fixture.dbPath);
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  function runner(onScan?: () => void) {
    const stub = createFetchStub([["/api/v3/movie", radarrPayload()]]);
    return new ReindexRunner({
      db,
      mediaRoot: fixture.mediaRoot,
      radarr: new RadarrClient({
        baseUrl: "http://radarr:7878",
        apiKey: "x",
        fetchImpl: async (url) => {
          onScan?.();
          return stub.fetch(url);
        },
      }),
      logger: silentLogger,
    });
  }

  it("queues a follow-up run instead of dropping a request made mid-run", async () => {
    // The walk snapshots the tree when it STARTS. Handing a concurrent caller
    // the in-flight promise answers 202 for work that can never include a file
    // imported after that point; the operator is told the rescan was accepted
    // and it never happens.
    let runs = 0;
    const r = runner(() => {
      runs += 1;
    });

    const first = r.run();
    const second = r.run();
    expect(second).not.toBe(first);

    await first;
    await second;
    expect(runs).toBe(2);
  });

  it("collapses many concurrent requests into exactly one follow-up", async () => {
    let runs = 0;
    const r = runner(() => {
      runs += 1;
    });

    const first = r.run();
    const queued = [r.run(), r.run(), r.run()];
    // All the mid-run callers share one follow-up.
    expect(queued[1]).toBe(queued[0]);
    expect(queued[2]).toBe(queued[0]);

    await Promise.all([first, ...queued]);
    expect(runs).toBe(2);
  });

  it("starts fresh once nothing is in flight", async () => {
    let runs = 0;
    const r = runner(() => {
      runs += 1;
    });

    await r.run();
    expect(r.isRunning).toBe(false);
    await r.run();
    expect(runs).toBe(2);
  });
});
