import { CatalogMissingError, CatalogUnusableError } from "../core/errors.js";
import { tokenize, type IndexRecord, type TermFrequencies } from "./index-record.js";
import { getCatalogState, readIndex, type CatalogStoreDeps } from "./store.js";
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

const REBUILD_REMEDY =
  "Run `reinvent-scout catalog sync` (or `catalog sync --reindex` to skip re-fetching).";

/**
 * Loads the local index, refusing rather than serving it when it can't be trusted. Two cases
 * refuse, both with `CatalogUnusableError` (distinct from `CatalogMissingError`, since the remedy
 * here is a local rebuild, not signing in and pulling from the network again):
 *
 * - `reason: "outdated"` -- a schema-version mismatch means the index on disk may have been
 *   written by a version of this tool with a fixed bug since. Concretely, `CURRENT_SCHEMA_VERSION`
 *   1 -> 2 exists because a stale index can hold a genuinely corrupted own-property value for any
 *   term that collided with `Object.prototype` on write (see index-record.ts's `tokenize`); the
 *   read-side `Object.hasOwn` guard in this module only stops a *false* match on an unaffected
 *   record, it cannot repair a term that really was poisoned when it was written.
 * - `reason: "corrupt"` -- meta.json itself couldn't be read, so the schema version is
 *   unknowable. The index may equally be poisoned in this case; there is no evidence either way,
 *   which makes refusing the consistent answer, not a weaker one just because the specific defect
 *   that motivated "outdated" can't be confirmed.
 *
 * Refusing outright in both cases is what actually makes a schema bump cause an existing index to
 * rebuild, rather than the bump being inert until something reads it.
 *
 * Staleness by age alone (it's been a while since the last sync) does *not* refuse -- that says
 * nothing about whether the index's own data is trustworthy, and refusing on it would defeat the
 * point of syncing the catalog locally in the first place.
 */
function requireCurrentIndex(deps: CatalogStoreDeps): IndexRecord[] {
  const state = getCatalogState(deps);
  if (state.status === "missing") {
    throw new CatalogMissingError();
  }
  if (state.status === "stale" && state.reason === "schema-version") {
    throw new CatalogUnusableError(
      "outdated",
      `Your local catalog index is from an older format and needs to be rebuilt. ${REBUILD_REMEDY}`,
    );
  }
  if (state.status === "stale" && state.reason === "corrupt") {
    throw new CatalogUnusableError(
      "corrupt",
      "Your catalog's sync metadata could not be read, so its format can't be confirmed safe. " +
        REBUILD_REMEDY,
    );
  }

  const index = readIndex(deps);
  if (index === null) {
    // meta.json reported present (possibly stale for another reason), but index.json itself is
    // missing or unreadable -- same remedy as "missing" from this caller's perspective.
    throw new CatalogMissingError();
  }
  return index;
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
 * Throws `CatalogMissingError` when nothing has ever been synced, or `CatalogUnusableError` when
 * the stored index can't be trusted -- an older schema version, or unreadable sync metadata (see
 * `requireCurrentIndex`).
 */
export function queryCatalog(
  deps: CatalogStoreDeps,
  options: CatalogQueryOptions = {},
): CatalogQueryResult[] {
  const index = requireCurrentIndex(deps);

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

export type SessionLookupResult =
  | { status: "found"; record: IndexRecord }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: IndexRecord[] };

/**
 * Resolves `catalog show`'s argument against the local index: first as an exact `sessionId`,
 * then -- case-insensitively -- as an `abbreviation`. `catalog search` prints only the
 * abbreviation (real session ids are opaque, e.g. `1780441461150001GGoc`), so the abbreviation is
 * the only thing a user actually has to paste back in; resolving only by id would make the
 * documented search-then-show flow unusable for every session in the catalog.
 *
 * Abbreviations are confirmed unique across the real 2,043-session catalog, but nothing in the
 * API guarantees that stays true (a future event, or a bug upstream, could repeat one), so a
 * token that matches more than one record is reported `"ambiguous"` with every candidate rather
 * than silently resolving to the first match.
 */
export function resolveSessionRecord(deps: CatalogStoreDeps, token: string): SessionLookupResult {
  const index = requireCurrentIndex(deps);

  const bySessionId = index.find((record) => record.sessionId === token);
  if (bySessionId !== undefined) {
    return { status: "found", record: bySessionId };
  }

  const normalizedToken = token.toLowerCase();
  const byAbbreviation = index.filter(
    (record) => record.abbreviation !== null && record.abbreviation.toLowerCase() === normalizedToken,
  );
  if (byAbbreviation.length === 1) {
    return { status: "found", record: byAbbreviation[0]! };
  }
  if (byAbbreviation.length > 1) {
    return { status: "ambiguous", candidates: byAbbreviation };
  }

  return { status: "not-found" };
}
