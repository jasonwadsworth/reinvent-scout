import { CatalogMissingError } from "../core/errors.js";
import { tokenize, type IndexRecord, type TermFrequencies } from "./index-record.js";
import { readIndex, type CatalogStoreDeps } from "./store.js";
import type { Venue } from "./venue.js";

/** A title term match is weighted higher than the same term appearing only in the body (abstract
 * plus taxonomy fields) -- a title hit is a much stronger relevance signal. */
const TITLE_TERM_WEIGHT = 3;
const BODY_TERM_WEIGHT = 1;

export interface LevelBandRange {
  /** Inclusive. */
  min: number;
  /** Inclusive. */
  max: number;
}

export interface CatalogQueryOptions {
  /** Free-text query, tokenized with the same rules used to build the index. Matches against
   * title terms (weighted higher) and body terms (abstract plus taxonomy fields). Omit to return
   * every session that passes the other filters, all scoring 0. */
  query?: string;
  type?: string;
  venue?: Venue;
  levelBand?: LevelBandRange;
  /** `YYYY-MM-DD`. A session with no `startDate` (unscheduled) never matches a day filter, since
   * there is no day to compare against. */
  day?: string;
  /** Caps the number of results returned, after sorting. */
  limit?: number;
}

export interface CatalogQueryResult {
  record: IndexRecord;
  score: number;
}

function matchesFilters(record: IndexRecord, options: CatalogQueryOptions): boolean {
  if (options.type !== undefined && record.type !== options.type) {
    return false;
  }
  if (options.venue !== undefined && record.venue !== options.venue) {
    return false;
  }
  if (options.levelBand !== undefined) {
    if (record.levelBand === null) {
      return false;
    }
    if (record.levelBand < options.levelBand.min || record.levelBand > options.levelBand.max) {
      return false;
    }
  }
  if (options.day !== undefined && record.startDate !== options.day) {
    return false;
  }
  return true;
}

/**
 * Reads a term's count from a term-frequency map, own-property only. `titleTerms`/`bodyTerms`
 * are written with a null prototype (see `index-record.ts`'s `tokenize`), but that guarantee
 * evaporates the moment they round-trip through `JSON.parse` to build the in-memory index this
 * function actually reads -- `JSON.parse` always produces plain, Object.prototype-inheriting
 * objects, regardless of the prototype of whatever was serialized. So a bare `map[term]` read
 * here would resolve a term like `constructor` to the inherited `Object` constructor function
 * for every record, not `undefined`, however the write side is hardened. `Object.hasOwn` is the
 * only check that is actually safe against this on the read side.
 */
function getOwnTermCount(map: TermFrequencies, term: string): number | undefined {
  return Object.hasOwn(map, term) ? (map[term] as number) : undefined;
}

/** Scores a record against the query's terms. Returns `null` (rather than a zero score) when a
 * query was given but none of its terms matched anywhere -- the caller excludes the record
 * entirely in that case, since a text search with zero relevance is a non-match, not a weak one. */
function scoreAgainstQuery(record: IndexRecord, queryTerms: string[]): number | null {
  let score = 0;
  let matched = false;
  for (const term of queryTerms) {
    const titleCount = getOwnTermCount(record.titleTerms, term);
    if (titleCount !== undefined) {
      score += TITLE_TERM_WEIGHT * titleCount;
      matched = true;
    }
    const bodyCount = getOwnTermCount(record.bodyTerms, term);
    if (bodyCount !== undefined) {
      score += BODY_TERM_WEIGHT * bodyCount;
      matched = true;
    }
  }
  return matched ? score : null;
}

function compareByAbbreviation(a: IndexRecord, b: IndexRecord): number {
  return (a.abbreviation ?? "").localeCompare(b.abbreviation ?? "");
}

/**
 * Searches and filters the local catalog index. Never touches the (potentially large) raw
 * session file -- abstracts and every other field not carried on `IndexRecord` are deliberately
 * unavailable here, per task 13's decision to keep the raw abstract out of the index; a caller
 * that needs it reads `readRaw` separately by `sessionId`.
 *
 * Results are ordered by score descending, then by `abbreviation` ascending as a deterministic
 * tiebreak -- ties are common (every result scores 0 when no `query` is given), so the tiebreak
 * runs constantly, not just as an edge case.
 *
 * Throws `CatalogMissingError` when nothing has ever been synced.
 */
export function queryCatalog(
  deps: CatalogStoreDeps,
  options: CatalogQueryOptions = {},
): CatalogQueryResult[] {
  const index = readIndex(deps);
  if (index === null) {
    throw new CatalogMissingError();
  }

  const queryTerms = options.query === undefined ? null : Object.keys(tokenize(options.query));

  const results: CatalogQueryResult[] = [];
  for (const record of index) {
    if (!matchesFilters(record, options)) {
      continue;
    }

    if (queryTerms === null) {
      results.push({ record, score: 0 });
      continue;
    }

    const score = scoreAgainstQuery(record, queryTerms);
    if (score !== null) {
      results.push({ record, score });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return compareByAbbreviation(a.record, b.record);
  });

  return options.limit === undefined ? results : results.slice(0, options.limit);
}

/**
 * Looks up a single session by id in the local index -- for `catalog show`. Returns `null` when
 * the id isn't in the catalog (a typo, or a session favorited before the last sync that no
 * longer exists); throws `CatalogMissingError` when nothing has ever been synced, same as
 * `queryCatalog`.
 */
export function getIndexRecord(deps: CatalogStoreDeps, sessionId: string): IndexRecord | null {
  const index = readIndex(deps);
  if (index === null) {
    throw new CatalogMissingError();
  }
  return index.find((record) => record.sessionId === sessionId) ?? null;
}
