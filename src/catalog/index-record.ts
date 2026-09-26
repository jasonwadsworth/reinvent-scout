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

/** Exported so `catalog/query.ts` tokenizes a search query with the exact same rules used to
 * build the index it searches -- a query term that doesn't survive the same lowercasing,
 * word-splitting and stopword removal as the indexed text would never be able to match it. */
export function tokenize(text: string): TermFrequencies {
  const counts: TermFrequencies = {};
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    if (STOPWORDS.has(word)) {
      continue;
    }
    counts[word] = (counts[word] ?? 0) + 1;
  }
  return counts;
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
