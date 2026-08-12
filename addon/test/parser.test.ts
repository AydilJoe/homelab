import { describe, expect, it } from "vitest";
import { normalizeTitle, parseFilename, parseSeasonEpisodes } from "../src/parser.js";

describe("parseFilename — movies", () => {
  it("handles the dotted scene form", () => {
    const parsed = parseFilename("movies/The.Matrix.1999.1080p.BluRay.x264-SOMEGROUP.mkv");
    expect(parsed.title).toBe("The Matrix");
    expect(parsed.year).toBe(1999);
    expect(parsed.resolution).toBe("1080p");
    expect(parsed.videoCodec).toBe("H.264");
    expect(parsed.season).toBeNull();
    expect(parsed.episodes).toEqual([]);
  });

  it("handles bracketed tags", () => {
    const parsed = parseFilename("movies/Arrival [2016] [2160p] [HEVC] [DTS-HD MA].mkv");
    expect(parsed.title).toBe("Arrival");
    expect(parsed.year).toBe(2016);
    expect(parsed.resolution).toBe("2160p");
    expect(parsed.videoCodec).toBe("H.265");
    expect(parsed.audioCodec).toBe("DTS-HD");
  });

  it("takes the year from the parent folder when the filename omits it", () => {
    const parsed = parseFilename("movies/Nosferatu (1922)/Nosferatu.mkv");
    expect(parsed.title).toBe("Nosferatu");
    expect(parsed.year).toBe(1922);
  });

  it("leaves resolution and codec null when the name says nothing (no ffprobe)", () => {
    const parsed = parseFilename("movies/Metropolis (1927)/Metropolis.mkv");
    expect(parsed.resolution).toBeNull();
    expect(parsed.videoCodec).toBeNull();
    expect(parsed.audioCodec).toBeNull();
  });

  it("maps 4K to 2160p", () => {
    expect(parseFilename("movies/Dune.2021.4K.HDR.mkv").resolution).toBe("2160p");
  });

  it("survives a name with nothing in it", () => {
    const parsed = parseFilename("movies/....mkv");
    expect(parsed.season).toBeNull();
    expect(parsed.episodes).toEqual([]);
    expect(typeof parsed.title).toBe("string");
  });
});

describe("parseFilename — non-English titles", () => {
  it("keeps accented Latin titles intact", () => {
    const parsed = parseFilename("movies/Amélie.2001.1080p.BluRay.x264.mkv");
    expect(parsed.title).toBe("Amélie");
    expect(parsed.year).toBe(2001);
  });

  it("keeps non-Latin scripts intact", () => {
    const parsed = parseFilename("movies/기생충.2019.1080p.WEB-DL.H.264.mkv");
    expect(parsed.title).toContain("기생충");
    expect(parsed.year).toBe(2019);
    expect(parsed.videoCodec).toBe("H.264");
  });

  it("normalises titles for cross-source comparison without mangling them", () => {
    expect(normalizeTitle("Amélie")).toBe("amélie");
    expect(normalizeTitle("The.Matrix - [1999]")).toBe("the matrix 1999");
    expect(normalizeTitle("기생충")).toBe("기생충");
  });
});

describe("parseFilename — series", () => {
  it("parses the standard SxxExx form", () => {
    const parsed = parseFilename("tv/Some Show/Season 01/Some.Show.S01E04.1080p.WEB-DL.DD5.1.H.264.mkv");
    expect(parsed.season).toBe(1);
    expect(parsed.episodes).toEqual([4]);
    expect(parsed.resolution).toBe("1080p");
    expect(parsed.videoCodec).toBe("H.264");
    expect(parsed.audioCodec).toBe("AC3");
  });

  it("parses the 1x01 form", () => {
    const parsed = parseFilename("tv/Some Show/Some Show 2x07.mkv");
    expect(parsed.season).toBe(2);
    expect(parsed.episodes).toEqual([7]);
  });

  it("does not mistake a resolution like 1920x1080 for an episode number", () => {
    const parsed = parseFilename("movies/Some.Film.2019.1920x1080.mkv");
    expect(parsed.season).toBeNull();
    expect(parsed.episodes).toEqual([]);
  });
});

describe("parseSeasonEpisodes — multi-episode files", () => {
  it("splits the concatenated form", () => {
    expect(parseSeasonEpisodes("Some.Show.S01E01E02.1080p.mkv")).toEqual({
      season: 1,
      episodes: [1, 2],
    });
  });

  it("expands an explicit range", () => {
    expect(parseSeasonEpisodes("Some.Show.S02E05-E07.mkv")).toEqual({
      season: 2,
      episodes: [5, 6, 7],
    });
  });

  it("expands the abbreviated range form", () => {
    expect(parseSeasonEpisodes("Some Show S03E10-12 [1080p].mkv")).toEqual({
      season: 3,
      episodes: [10, 11, 12],
    });
  });

  it("does not read a trailing quality tag as a range", () => {
    expect(parseSeasonEpisodes("Some.Show.S01E01-1080p.mkv")).toEqual({
      season: 1,
      episodes: [1],
    });
  });

  it("expands a full-season pack rather than keeping only the endpoints", () => {
    // Regression: the range branch used to bail out on spans wider than 20 and
    // fall through to the episode-list form, whose separator class eats the
    // hyphen — "S01E01-E24" came back as [1, 24], silently indexing a season
    // pack as episodes 1 and 24 with nothing in between.
    const parsed = parseSeasonEpisodes("Some.Show.S01E01-E24.1080p.mkv");
    expect(parsed.season).toBe(1);
    expect(parsed.episodes).toHaveLength(24);
    expect(parsed.episodes[0]).toBe(1);
    expect(parsed.episodes[23]).toBe(24);
  });

  it("reports no episodes for an implausible span so the file lands in unmatched", () => {
    // Wrong rows are worse than a reported miss (6.4): no episodes means the
    // indexer records the file with a reason instead of inventing entries.
    expect(parseSeasonEpisodes("Some.Show.S01E01-E999.mkv")).toEqual({ season: 1, episodes: [] });
  });

  it("does not let parse-torrent-title resurrect a rejected span", () => {
    // The guard above only holds if the ptt fallback stays out of the way.
    // ptt reads "S01E01-E200" as plain episode 1, so before the `rejected`
    // flag existed the file was indexed as a single episode — the exact
    // opposite of what the guard promises.
    const parsed = parseFilename("tv/Some Show/Some.Show.S01E01-E200.mkv");
    expect(parsed.season).toBe(1);
    expect(parsed.episodes).toEqual([]);
    expect(parsed.episodeSpanRejected).toBe(true);
  });

  it("leaves episodeSpanRejected false for a plausible pack", () => {
    expect(parseFilename("tv/Some Show/Some.Show.S01E01-E24.mkv").episodeSpanRejected).toBe(false);
  });

  it("reads a year-numbered season", () => {
    expect(parseSeasonEpisodes("Some.Show.S2010E05.mkv")).toEqual({ season: 2010, episodes: [5] });
  });

  it("returns nothing for a name with no season marker", () => {
    expect(parseSeasonEpisodes("Some.Film.2019.1080p.mkv")).toEqual({ season: null, episodes: [] });
  });
});

describe("parseFilename — title recovery around season markers", () => {
  it("strips a season marker parse-torrent-title does not recognise", () => {
    // ptt leaves "S2010E05" sitting in the title; searching Cinemeta with that
    // would never match, so the marker is cut off the end.
    const parsed = parseFilename("tv/Some Show/Some.Show.S2010E05.mkv");
    expect(parsed.title).toBe("Some Show");
    expect(parsed.season).toBe(2010);
    expect(parsed.episodes).toEqual([5]);
  });

  it("falls back to the series folder when the filename is nothing but a marker", () => {
    const parsed = parseFilename("tv/Some Show/S01E01.mkv");
    expect(parsed.title).toBe("Some Show");
    expect(parsed.episodes).toEqual([1]);
  });

  it("steps over a season folder to reach the series folder", () => {
    expect(parseFilename("tv/Some Show/Season 01/S01E01.mkv").title).toBe("Some Show");
    expect(parseFilename("tv/Some Show/S01/S01E02.mkv").title).toBe("Some Show");
    expect(parseFilename("tv/Some Show/Specials/S00E01.mkv").title).toBe("Some Show");
  });

  it("leaves a movie title alone", () => {
    expect(parseFilename("movies/The.Matrix.1999.1080p.mkv").title).toBe("The Matrix");
    expect(parseFilename("movies/Nosferatu (1922)/Nosferatu.mkv").title).toBe("Nosferatu");
  });
});
