import path from "node:path";
import ptt from "parse-torrent-title";

/**
 * Filename parsing. `parse-torrent-title` does the hard part (stripping release
 * junk off the title); everything below either normalises its output into the
 * display forms the stream line needs ("H.264", "1080p") or covers cases it
 * does not handle, notably multi-episode files.
 *
 * There is no ffprobe anywhere in this addon (6.6 note): resolution and codecs
 * come from the filename only, and are therefore nullable.
 */

export interface ParsedName {
  title: string;
  year: number | null;
  /** null when the name carries no season marker at all (i.e. probably a movie). */
  season: number | null;
  /** Usually 0 or 1 entries; more than one for a multi-episode file. */
  episodes: number[];
  /**
   * A season/episode range was present but implausible (spanning
   * MAX_EPISODE_SPAN or more), so `episodes` is empty on purpose. Lets the
   * indexer record a precise `unmatched` reason instead of a generic one.
   */
  episodeSpanRejected: boolean;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

interface PttResult {
  title?: string;
  year?: number | string;
  season?: number;
  episode?: number;
  resolution?: string;
  codec?: string;
  audio?: string;
}

const EXTENSION_RE = /\.[A-Za-z0-9]{2,4}$/;

/**
 * Upper bound on how many episodes one file may claim to hold. Junk like
 * "S01E01-1080p" is already rejected by the trailing \b in EPISODE_RANGE_RE,
 * so this only has to be generous enough for genuine season packs — a
 * 24-episode network season is routine and anime runs longer still.
 */
export const MAX_EPISODE_SPAN = 100;

/**
 * "S01E01-E03" / "S01E01-03" — an inclusive range of episodes in one file.
 * The season group allows four digits so year-numbered seasons ("S2010E05",
 * which Sonarr emits for date-based series) are not misread as movies.
 */
const EPISODE_RANGE_RE = /\bs(\d{1,4})[\s._-]*e(\d{1,3})[\s._-]*-[\s._-]*e?(\d{1,3})\b/i;
/** "S01E01" / "S01E01E02" / "S01.E01.E02" — one or more explicit episode numbers. */
const EPISODE_LIST_RE = /\bs(\d{1,4})((?:[\s._-]*e\d{1,3})+)/i;
/** "1x01" */
const ALT_EPISODE_RE = /\b(\d{1,2})x(\d{1,3})\b/i;
const EPISODE_NUMBER_RE = /e(\d{1,3})/gi;
/** "1920x1080" — a resolution, not a season/episode pair. */
const DIMENSIONS_RE = /\b\d{3,4}\s?x\s?\d{3,4}\b/i;
/**
 * "Season 01" / "S01" / "Specials" — a season folder carries no title, so the
 * title fallback has to step over it to the series folder above.
 */
const SEASON_DIR_RE = /^(season[\s._-]*\d{1,4}|s\d{1,4}|specials)$/i;

const RESOLUTION_ALIASES: Array<[RegExp, string]> = [
  [/^(2160p?|4k|uhd)$/i, "2160p"],
  [/^(1440p?|2k)$/i, "1440p"],
  [/^1080p?$/i, "1080p"],
  [/^720p?$/i, "720p"],
  [/^576p?$/i, "576p"],
  [/^480p?$/i, "480p"],
];

const RESOLUTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(2160p|4k|uhd)\b/i, "2160p"],
  [/\b(1440p)\b/i, "1440p"],
  [/\b(1080p)\b/i, "1080p"],
  [/\b(720p)\b/i, "720p"],
  [/\b(576p)\b/i, "576p"],
  [/\b(480p)\b/i, "480p"],
];

/** Order matters: 265 before 264 so "x265" is not shadowed by a loose match. */
const VIDEO_CODEC_PATTERNS: Array<[RegExp, string]> = [
  [/\b(x\.?265|h\.?265|hevc)\b/i, "H.265"],
  [/\b(x\.?264|h\.?264|avc)\b/i, "H.264"],
  [/\bav1\b/i, "AV1"],
  [/\bvp9\b/i, "VP9"],
  [/\bmpeg-?2\b/i, "MPEG-2"],
  [/\bxvid\b/i, "XviD"],
  [/\bdivx\b/i, "DivX"],
];

const AUDIO_CODEC_PATTERNS: Array<[RegExp, string]> = [
  [/\batmos\b/i, "Atmos"],
  [/\btruehd\b/i, "TrueHD"],
  [/\bdts[-. ]?hd([-. ]?ma)?\b/i, "DTS-HD"],
  [/\bdts\b/i, "DTS"],
  [/\b(e-?ac-?3|eac3|ddp\d?(\.\d)?|dd\+)\b/i, "E-AC3"],
  [/\b(ac-?3|dd\d(\.\d)?)\b/i, "AC3"],
  [/\baac\d?(\.\d)?\b/i, "AAC"],
  [/\bflac\b/i, "FLAC"],
  [/\bopus\b/i, "Opus"],
  [/\bmp3\b/i, "MP3"],
];

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function toYear(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.slice(0, 4), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function firstMatch(patterns: Array<[RegExp, string]>, haystack: string): string | null {
  for (const [pattern, label] of patterns) {
    if (pattern.test(haystack)) return label;
  }
  return null;
}

function unique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Lowercase, punctuation-free form used for comparing titles across sources.
 * Unicode-aware so non-Latin titles survive it intact.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface SeasonEpisodeMatch {
  season: number | null;
  episodes: number[];
  /** Offset of the season/episode marker in `name`, or -1 when nothing matched. */
  index: number;
  /**
   * True when a marker WAS found and deliberately rejected (an implausible
   * span). "No marker" and "rejected marker" must not be conflated: the first
   * may fall through to parse-torrent-title, the second must not — otherwise
   * ptt substitutes its own single episode number and the file is indexed as
   * one episode instead of landing in `unmatched`.
   */
  rejected: boolean;
}

/** Turn a raw filename fragment into a display title: separators to spaces, edges tidied. */
function cleanTitle(fragment: string): string {
  return fragment
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:(\[]+|[\s\-–—:)\]]+$/g, "")
    .trim();
}

/** Season + episode numbers straight off the name, multi-episode files included. */
export function parseSeasonEpisodes(name: string): { season: number | null; episodes: number[] } {
  const { season, episodes } = matchSeasonEpisodes(name);
  return { season, episodes };
}

function matchSeasonEpisodes(name: string): SeasonEpisodeMatch {
  const range = EPISODE_RANGE_RE.exec(name);
  if (range) {
    const season = toInt(range[1]);
    const from = toInt(range[2]);
    const to = toInt(range[3]);
    if (season !== null && from !== null && to !== null && to >= from) {
      // Authoritative: once a coherent range is recognised we must NOT fall
      // through to EPISODE_LIST_RE. Its separator class swallows the hyphen, so
      // "S01E01-E24" would come back as the two endpoints [1, 24] — a season
      // pack silently indexed as episodes 1 and 24 and nothing between them.
      if (to - from >= MAX_EPISODE_SPAN) {
        // Implausible span: report no episodes so the indexer files the file
        // under `unmatched` with a reason (6.4) rather than inventing rows.
        return { season, episodes: [], index: range.index, rejected: true };
      }
      const episodes: number[] = [];
      for (let episode = from; episode <= to; episode += 1) episodes.push(episode);
      return { season, episodes, index: range.index, rejected: false };
    }
  }

  const list = EPISODE_LIST_RE.exec(name);
  if (list) {
    const season = toInt(list[1]);
    const episodes = [...(list[2] ?? "").matchAll(EPISODE_NUMBER_RE)]
      .map((match) => toInt(match[1]))
      .filter((episode): episode is number => episode !== null);
    if (season !== null && episodes.length > 0) {
      return { season, episodes: unique(episodes), index: list.index, rejected: false };
    }
  }

  const alt = ALT_EPISODE_RE.exec(name);
  if (alt) {
    const season = toInt(alt[1]);
    const episode = toInt(alt[2]);
    if (season !== null && episode !== null) {
      return { season, episodes: [episode], index: alt.index, rejected: false };
    }
  }

  return { season: null, episodes: [], index: -1, rejected: false };
}

function parseResolution(pttResolution: string | undefined, name: string): string | null {
  if (pttResolution) {
    const alias = firstMatch(RESOLUTION_ALIASES, pttResolution.trim());
    if (alias) return alias;
  }
  return firstMatch(RESOLUTION_PATTERNS, name);
}

/**
 * Parse one file path. Accepts a full rel_path — the parent directory is used
 * as a fallback for the title (a bare "Film.mkv" inside "Film (2024)/") and for
 * a year the filename omits.
 */
export function parseFilename(relPath: string): ParsedName {
  const posixPath = relPath.replace(/\\/g, "/");
  const base = path.posix.basename(posixPath).replace(EXTENSION_RE, "");
  const dirPath = path.posix.dirname(posixPath);
  const immediateParent = path.posix.basename(dirPath);
  // "Some Show/Season 01/S01E01.mkv" — the season folder is not the title.
  const parentDir = SEASON_DIR_RE.test(immediateParent.trim())
    ? path.posix.basename(path.posix.dirname(dirPath))
    : immediateParent;

  const parsed = ptt.parse(base) as PttResult;
  let title = (parsed.title ?? "").trim();
  let year = toYear(parsed.year);

  const { season, episodes, index: markerIndex, rejected } = matchSeasonEpisodes(base);

  // parse-torrent-title does not recognise every season/episode form (year
  // seasons like "S2010E05", for one) and leaves the marker sitting in the
  // title when it fails. That polluted title is what the Cinemeta fallback
  // would search on, so cut it back to the text before the marker — but only
  // when ptt has demonstrably left the marker behind. A marker at offset 0
  // means the filename is nothing BUT the marker ("S01E01.mkv"), which leaves
  // no title at all and hands the job to the parent folder below.
  if (markerIndex >= 0 && season !== null) {
    const marker = base.slice(markerIndex);
    if (normalizeTitle(title).includes(normalizeTitle(marker))) {
      title = cleanTitle(base.slice(0, markerIndex));
    }
  }

  const parentUsable = parentDir !== "" && parentDir !== "." && parentDir !== "/";
  if (parentUsable) {
    const fromParent = ptt.parse(parentDir) as PttResult;
    const parentTitle = (fromParent.title ?? "").trim();
    if (title === "") {
      title = parentTitle;
      year = year ?? toYear(fromParent.year);
    } else if (year === null && normalizeTitle(parentTitle) === normalizeTitle(title)) {
      // "Film (2024)/Film.mkv" — the folder carries the year, the file does not.
      year = toYear(fromParent.year);
    }
  }

  // parse-torrent-title reads "1920x1080" as season 20 episode 1080, so its
  // season/episode are only trusted when the name carries no pixel dimensions.
  // `rejected` also blocks the fallback: for "S01E01-E200" ptt happily reports
  // episode 1, which would quietly index a nonsense span as a single episode
  // and defeat the MAX_EPISODE_SPAN guard entirely.
  const usePttEpisodes = episodes.length === 0 && !rejected && !DIMENSIONS_RE.test(base);
  const fallbackSeason = season ?? (usePttEpisodes && typeof parsed.season === "number" ? parsed.season : null);
  const fallbackEpisodes =
    episodes.length > 0
      ? episodes
      : usePttEpisodes && typeof parsed.episode === "number"
        ? [parsed.episode]
        : [];

  return {
    title,
    year,
    season: fallbackSeason,
    episodes: fallbackEpisodes,
    episodeSpanRejected: rejected,
    resolution: parseResolution(parsed.resolution, base),
    videoCodec: firstMatch(VIDEO_CODEC_PATTERNS, `${parsed.codec ?? ""} ${base}`),
    audioCodec: firstMatch(AUDIO_CODEC_PATTERNS, `${parsed.audio ?? ""} ${base}`),
  };
}
