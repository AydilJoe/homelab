import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaIndex } from "../src/db.js";
import {
  buildMediaUrl,
  createStreamHandler,
  describeStream,
  formatSize,
  parseStremioId,
  sortBestFirst,
  toStream,
} from "../src/stream.js";
import { createFixture, mediaRow, type Fixture } from "./helpers.js";

describe("parseStremioId", () => {
  it("reads a movie id", () => {
    expect(parseStremioId("tt0111161")).toEqual({ imdbId: "tt0111161", season: 0, episode: 0 });
  });

  it("splits a series id on colons", () => {
    expect(parseStremioId("tt1234567:1:5")).toEqual({ imdbId: "tt1234567", season: 1, episode: 5 });
  });

  it("accepts season 0 (specials)", () => {
    expect(parseStremioId("tt1234567:0:2")).toEqual({ imdbId: "tt1234567", season: 0, episode: 2 });
  });

  it.each([
    ["", "empty"],
    ["tt", "no digits"],
    ["1234567", "no tt prefix"],
    ["kitsu:123", "another id namespace"],
    ["tt1234567:1", "season without episode"],
    ["tt1234567:a:b", "non-numeric parts"],
    ["tt1234567:1:2:3", "too many parts"],
    ["tt1234567:-1:2", "negative season"],
    ["tt1234567::5", "empty season"],
  ])("rejects %j (%s)", (id) => {
    expect(parseStremioId(id)).toBeNull();
  });
});

describe("stream URL and description", () => {
  it("percent-encodes each path segment and keeps the slashes", () => {
    expect(buildMediaUrl("https://media.example.ts.net", "movies/Film (2024)/Film.mkv")).toBe(
      "https://media.example.ts.net/media/movies/Film%20(2024)/Film.mkv",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(buildMediaUrl("http://192.168.1.50/", "movies/a b.mkv")).toBe(
      "http://192.168.1.50/media/movies/a%20b.mkv",
    );
  });

  it("formats sizes the way the spec example does", () => {
    expect(formatSize(4_509_715_660)).toBe("4.2 GB");
    expect(formatSize(700 * 1024 * 1024)).toBe("700 MB");
    expect(formatSize(0)).toBe("0 MB");
  });

  it("builds the description line, dropping unknown fields", () => {
    expect(describeStream(mediaRow())).toBe("1080p • H.264 • 4.2 GB");
    expect(describeStream(mediaRow({ resolution: null, video_codec: null }))).toBe("4.2 GB");
  });

  it("sets both description and title, plus the behaviour hints", () => {
    const stream = toStream(mediaRow(), "http://192.168.1.50");
    expect(stream.name).toBe("Local");
    expect(stream.description).toBe(stream.title);
    expect(stream.behaviorHints).toEqual({
      bingeGroup: "local-tt0111161",
      videoSize: 4_509_715_660,
      filename: "film.mkv",
    });
  });
});

describe("sortBestFirst (O2)", () => {
  it("orders by resolution, then size, and puts unknown resolutions last", () => {
    const rows = [
      mediaRow({ rel_path: "a-720.mkv", resolution: "720p", size_bytes: 3_000_000_000 }),
      mediaRow({ rel_path: "b-unknown.mkv", resolution: null, size_bytes: 9_000_000_000 }),
      mediaRow({ rel_path: "c-1080-small.mkv", resolution: "1080p", size_bytes: 4_000_000_000 }),
      mediaRow({ rel_path: "d-2160.mkv", resolution: "2160p", size_bytes: 1_000_000_000 }),
      mediaRow({ rel_path: "e-1080-big.mkv", resolution: "1080p", size_bytes: 8_000_000_000 }),
    ];
    expect(sortBestFirst(rows).map((row) => row.rel_path)).toEqual([
      "d-2160.mkv",
      "e-1080-big.mkv",
      "c-1080-small.mkv",
      "a-720.mkv",
      "b-unknown.mkv",
    ]);
  });
});

describe("stream handler", () => {
  let fixture: Fixture;
  let db: MediaIndex;

  beforeEach(() => {
    fixture = createFixture({});
    db = new MediaIndex(fixture.dbPath);
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  it("returns every quality of one title, best first (O2)", async () => {
    db.replaceAll(
      [
        mediaRow({ rel_path: "movies/Film/Film.720p.mkv", resolution: "720p", size_bytes: 2e9 }),
        mediaRow({ rel_path: "movies/Film/Film.2160p.mkv", resolution: "2160p", size_bytes: 20e9 }),
        mediaRow({ rel_path: "movies/Film/Film.1080p.mkv", resolution: "1080p", size_bytes: 8e9 }),
      ],
      [],
    );

    const handler = createStreamHandler({ db, publicBaseUrl: "http://192.168.1.50" });
    const result = await handler({ type: "movie", id: "tt0111161" });

    expect(result.streams.map((stream) => stream.url)).toEqual([
      "http://192.168.1.50/media/movies/Film/Film.2160p.mkv",
      "http://192.168.1.50/media/movies/Film/Film.1080p.mkv",
      "http://192.168.1.50/media/movies/Film/Film.720p.mkv",
    ]);
    expect(result.cacheMaxAge).toBe(3600);
    expect(result.staleRevalidate).toBe(7200);
  });

  it("looks up an episode by season and episode number", async () => {
    db.replaceAll(
      [
        mediaRow({
          imdb_id: "tt1234567",
          type: "series",
          season: 1,
          episode: 2,
          rel_path: "tv/Show/S01E02.mkv",
          match_source: "sonarr",
        }),
      ],
      [],
    );

    const handler = createStreamHandler({ db, publicBaseUrl: "http://192.168.1.50" });
    expect((await handler({ type: "series", id: "tt1234567:1:2" })).streams).toHaveLength(1);
    expect((await handler({ type: "series", id: "tt1234567:1:3" })).streams).toEqual([]);
  });
});
