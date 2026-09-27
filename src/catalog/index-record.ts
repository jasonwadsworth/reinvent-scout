import type { Session, SeatAvailability } from "../api/types.js";
import { deriveVenue, type Venue } from "./venue.js";

/**
 * A small, generic English stopword list. Deliberately not exhaustive -- this only needs to
 * keep the highest-frequency function words out of the term-frequency map so they don't drown
 * out the AWS-service and topic vocabulary that actually distinguishes one session from
 * another; a missed stopword just becomes a low-signal term the scorer weighs like any other.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "how", "in",
  "into", "is", "it", "its", "of", "on", "or", "our", "that", "the", "this", "to", "use",
  "using", "we", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

export type TermFrequencies = Record<string, number>;

/** A token shorter than this is dropped unless it's a real acronym (see `isAllCapsAcronym`) --
 * below this length, a plain word carries too little signal on its own ("no", "for" -- already a
 * stopword, "aim") and is far more likely to be a fragment or filler than a meaningful term.
 *
 * This is also what handles a possessive like "agent's": the apostrophe isn't a word character, so
 * word-splitting alone already turns it into "agent" and a bare "s" fragment with nothing extra
 * needed -- and that orphaned "s" is always exactly one character, so this filter drops it
 * unconditionally regardless of the base word. An earlier version also stripped `'s`/`'s` from the
 * text before splitting, as a second, explicit mechanism for the same fragment; sabotage testing
 * showed the two were fully redundant (disabling either alone, with the other still active, left
 * every test green), so the dedicated stripping step was removed as dead code. This comment is the
 * load-bearing part now: if `MIN_TERM_LENGTH` is ever lowered below 2, the possessive fragment
 * problem comes back, silently, with no dedicated mechanism left to catch it. */
const MIN_TERM_LENGTH = 3;

/** True when `word`, exactly as it appeared in the original (not lowercased) text, is written
 * entirely in capitals and is at least two characters -- "S3", "ML", "AI". This is the one
 * exception to `MIN_TERM_LENGTH`: real acronyms are often shorter than three characters and carry
 * plenty of signal (a service name, a discipline), but only when the source text itself marks them
 * as an acronym by capitalizing them -- a lowercase "ai" or "ml" in ordinary prose is far more
 * likely filler than a deliberate short technical term, and a bare short number like "60" has no
 * letters to capitalize at all, so it can never qualify. */
function isAllCapsAcronym(word: string): boolean {
  return word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word);
}

/** Exported so `catalog/query.ts` tokenizes a search query with the exact same rules used to
 * build the index it searches -- a query term that doesn't survive the same lowercasing,
 * word-splitting, short-fragment filtering and stopword removal as the indexed text would never be
 * able to match it. */
export function tokenize(text: string): TermFrequencies {
  // A plain object literal inherits Object.prototype, so a tokenized word that collides with one
  // of its members (`constructor`, `hasOwnProperty`, `toString`, ...) reads back a function
  // instead of undefined from `counts[word]`, silently turning `+ 1` into string concatenation.
  // Object.create(null) has no prototype at all, so every lookup below reflects only what this
  // function itself has written.
  const counts: TermFrequencies = Object.create(null) as TermFrequencies;
  // Matched against the original casing (not yet lowercased) so isAllCapsAcronym can tell a real
  // acronym from an ordinary short word that only happens to share its letters.
  const words = text.match(/[A-Za-z0-9]+/g) ?? [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOPWORDS.has(lower)) {
      continue;
    }
    if (lower.length < MIN_TERM_LENGTH && !isAllCapsAcronym(word)) {
      continue;
    }
    counts[lower] = (counts[lower] ?? 0) + 1;
  }
  return counts;
}

/**
 * Reads a term's count from a term-frequency map, own-property only. `titleTerms`/`bodyTerms`
 * are written with a null prototype (see `tokenize` above), but that guarantee evaporates the
 * moment they round-trip through `JSON.parse` to build the in-memory index a reader actually
 * works with -- `JSON.parse` always produces plain, `Object.prototype`-inheriting objects,
 * regardless of the prototype of whatever was serialized. So a bare `map[term]` read here would
 * resolve a term like `constructor` to the inherited `Object` constructor function for every
 * record, not `undefined`, however the write side is hardened. `Object.hasOwn` is the only check
 * that is actually safe against this on the read side. Shared by `catalog/query.ts` and
 * `match/score.ts`, the two readers of these maps.
 */
export function getOwnTermCount(map: TermFrequencies, term: string): number | undefined {
  return Object.hasOwn(map, term) ? (map[term] as number) : undefined;
}

/** Extracts the leading numeric band from a level string like `"300 - Advanced"`. Returns null
 * when the string doesn't start with a number, including when there's no level at all. */
function parseLevelBand(level: string | undefined): number | null {
  if (level === undefined) {
    return null;
  }
  const match = /^(\d+)/.exec(level);
  return match ? Number(match[1]) : null;
}

/** Parses the API's `sessionTime.length` (minutes, as a string) into a number. */
function parseLengthMinutes(length: string | undefined): number | null {
  if (length === undefined) {
    return null;
  }
  const minutes = Number(length);
  return Number.isFinite(minutes) ? minutes : null;
}

export interface IndexRecord {
  sessionId: string;
  abbreviation: string | null;
  title: string;
  type: string | null;
  level: string | null;
  levelBand: number | null;
  venue: Venue | null;
  room: string | null;
  startDate: string | null;
  startTime: string | null;
  lengthMinutes: number | null;
  services: string[];
  topics: string[];
  areasOfInterest: string[];
  roles: string[];
  features: string[];
  industries: string[];
  speakerCount: number;
  isReservable: boolean;
  seatAvailability: SeatAvailability | null;
  /** Terms from the title alone, weighted separately so the scorer can favor a title match. */
  titleTerms: TermFrequencies;
  /** Terms from the abstract and every taxonomy field combined. Never the raw abstract text. */
  bodyTerms: TermFrequencies;
}

/** The subset of `IndexRecord` that's safe to hand to a user or an agent -- strips `titleTerms`
 * and `bodyTerms`, the scorer's own internal term-frequency maps, which are an implementation
 * detail of `match/score.ts` and `catalog/query.ts`'s local search, never agent- or user-facing
 * output on their own. Shared by `cli/commands/catalog.ts`'s `search`/`show` and
 * `cli/commands/match.ts`, so there is exactly one list of public fields to keep in sync with
 * `IndexRecord`, not one per caller. */
export function toPublicIndexRecord(record: IndexRecord): Omit<IndexRecord, "titleTerms" | "bodyTerms"> {
  return {
    sessionId: record.sessionId,
    abbreviation: record.abbreviation,
    title: record.title,
    type: record.type,
    level: record.level,
    levelBand: record.levelBand,
    venue: record.venue,
    room: record.room,
    startDate: record.startDate,
    startTime: record.startTime,
    lengthMinutes: record.lengthMinutes,
    services: record.services,
    topics: record.topics,
    areasOfInterest: record.areasOfInterest,
    roles: record.roles,
    features: record.features,
    industries: record.industries,
    speakerCount: record.speakerCount,
    isReservable: record.isReservable,
    seatAvailability: record.seatAvailability,
  };
}

/**
 * Builds a local index record from one raw API session, tolerant of every field the real
 * catalog is known to omit (see docs/plans/2026-09-25-phase1.md's catalog facts): missing
 * `level`, missing `room`/`sessionTime`, and empty or absent taxonomy arrays are all normal,
 * not errors.
 */
export function buildIndexRecord(session: Session): IndexRecord {
  const bodyText = [
    session.abstract ?? "",
    ...(session.topics ?? []),
    ...(session.areasOfInterest ?? []),
    ...(session.roles ?? []),
    ...(session.services ?? []),
    ...(session.industries ?? []),
    ...(session.features ?? []),
  ].join(" ");

  return {
    sessionId: session.sessionId,
    abbreviation: session.abbreviation ?? null,
    title: session.title,
    type: session.type ?? null,
    level: session.level ?? null,
    levelBand: parseLevelBand(session.level),
    venue: deriveVenue({
      ...(session.venue === undefined ? {} : { venue: session.venue }),
      ...(session.room === undefined ? {} : { room: session.room }),
    }),
    room: session.room ?? null,
    startDate: session.sessionTime?.date ?? null,
    startTime: session.sessionTime?.time ?? null,
    lengthMinutes: parseLengthMinutes(session.sessionTime?.length),
    services: session.services ?? [],
    topics: session.topics ?? [],
    areasOfInterest: session.areasOfInterest ?? [],
    roles: session.roles ?? [],
    features: session.features ?? [],
    industries: session.industries ?? [],
    speakerCount: session.speakers?.length ?? 0,
    isReservable: session.isReservable ?? false,
    seatAvailability: session.seatAvailability ?? null,
    titleTerms: tokenize(session.title),
    bodyTerms: tokenize(bodyText),
  };
}
