import { CatalogMissingError, CatalogUnusableError } from "../core/errors.js";
import { getOwnTermCount, tokenize, type IndexRecord } from "./index-record.js";
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
export function requireCurrentIndex(deps: CatalogStoreDeps): IndexRecord[] {
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

  const queryTerms =
    options.query === undefined
      ? null
      : Object.keys(tokenize(options.query, { keepShortTokens: true }));

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
  | { status: "found"; record: IndexRecord; relatedAbbreviations: string[] }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: IndexRecord[] };

/**
 * The real catalog's own repeat-sitting suffix: `-R` optionally followed by digits --
 * `ARC325-R`, `ARC325-R1`, `ARC325-R2` are the same talk sat on different days. Deliberately
 * narrow, matching only `R`: a broader `-[A-Z]\d*$` would also match `-S`, the catalog's unrelated
 * marker for a sponsored session, and the real catalog has at least one base code where that
 * collision is not hypothetical -- `AIM214` (a SageMaker session) and `AIM214-S` (an unrelated
 * sponsored talk) share a base string but are two different sessions. Exported so `match.ts`
 * groups repeat sittings by the exact same rule this module resolves `catalog show <base code>`
 * with, rather than each maintaining its own copy that could drift apart.
 */
export const REPEAT_SUFFIX_PATTERN = /-R\d*$/;

/** The group identity a repeat session shares with its siblings: its `abbreviation` with any
 * repeat suffix removed, or its `sessionId` when it has no abbreviation at all (which can't
 * collide with a real abbreviation-derived code, and can't itself be shared by two different
 * sessions, so it's always a safe, unique fallback group of one). */
export function baseSessionCode(record: IndexRecord): string {
  if (record.abbreviation === null) {
    return record.sessionId;
  }
  return record.abbreviation.replace(REPEAT_SUFFIX_PATTERN, "");
}

/** Ascending by start date then start time; a record with no `startDate` at all (unscheduled)
 * sorts last, since there's nothing yet to place it relative to a scheduled one. */
function compareByStartDateTime(a: IndexRecord, b: IndexRecord): number {
  if (a.startDate !== b.startDate) {
    if (a.startDate === null) {
      return 1;
    }
    if (b.startDate === null) {
      return -1;
    }
    return a.startDate.localeCompare(b.startDate);
  }
  return (a.startTime ?? "").localeCompare(b.startTime ?? "");
}

/**
 * Resolves `catalog show`'s argument against the local index: first as an exact `sessionId`, then
 * -- case-insensitively -- as an `abbreviation`, then -- also case-insensitively -- as a *base*
 * code with any repeat suffix stripped (see `baseSessionCode`). `catalog search` prints only the
 * abbreviation (real session ids are opaque, e.g. `1780441461150001GGoc`), so the abbreviation is
 * the only thing a user actually has to paste back in; resolving only by id would make the
 * documented search-then-show flow unusable for every session in the catalog. The base-code
 * fallback matters because `match`'s own grouped output prints a candidate's `code`, not any one
 * sitting's abbreviation (see `match.ts`), and that code often isn't a real abbreviation on its
 * own -- `catalog show` needs to resolve exactly what `match` just printed.
 *
 * When several sittings share a base code, the *earliest* by start date and time is the `record`
 * returned, and every other sitting's abbreviation is listed in `relatedAbbreviations` -- this is
 * not reported `"ambiguous"`, since a repeat group sharing a base code is expected, not a data
 * integrity concern the way two unrelated sessions sharing a real abbreviation would be.
 *
 * Abbreviations are confirmed unique across the real 2,043-session catalog, but nothing in the
 * API guarantees that stays true (a future event, or a bug upstream, could repeat one), so a
 * token that matches more than one record *by abbreviation* is reported `"ambiguous"` with every
 * candidate rather than silently resolving to the first match.
 */
export function resolveSessionRecord(deps: CatalogStoreDeps, token: string): SessionLookupResult {
  const index = requireCurrentIndex(deps);

  const bySessionId = index.find((record) => record.sessionId === token);
  if (bySessionId !== undefined) {
    return { status: "found", record: bySessionId, relatedAbbreviations: [] };
  }

  const normalizedToken = token.toLowerCase();
  const byAbbreviation = index.filter(
    (record) => record.abbreviation !== null && record.abbreviation.toLowerCase() === normalizedToken,
  );
  if (byAbbreviation.length === 1) {
    const found = byAbbreviation[0]!;
    // The token matched one sitting's own abbreviation exactly (e.g. "API303-R"), not the bare
    // base code -- but that sitting can still belong to a repeat group (its sibling would be
    // "API303-R1"). Report every *other* sitting sharing the same base code here too, the same
    // way the base-code fallback below does, so which lookup form the caller used doesn't change
    // whether the group's other sittings are surfaced.
    const code = baseSessionCode(found).toLowerCase();
    const siblings = index
      .filter((record) => record.sessionId !== found.sessionId && baseSessionCode(record).toLowerCase() === code)
      .sort(compareByStartDateTime);
    return {
      status: "found",
      record: found,
      relatedAbbreviations: siblings.map((record) => record.abbreviation).filter((a) => a !== null),
    };
  }
  if (byAbbreviation.length > 1) {
    return { status: "ambiguous", candidates: byAbbreviation };
  }

  const byBaseCode = index
    .filter((record) => baseSessionCode(record).toLowerCase() === normalizedToken)
    .sort(compareByStartDateTime);
  if (byBaseCode.length > 0) {
    const [earliest, ...rest] = byBaseCode;
    return {
      status: "found",
      record: earliest!,
      relatedAbbreviations: rest.map((record) => record.abbreviation).filter((a) => a !== null),
    };
  }

  return { status: "not-found" };
}

/**
 * Every distinct service name across the whole local catalog index, deduplicated -- the input
 * `catalog/service-aliases.ts`'s `buildServiceAliasIndex` needs to derive aliases from, and
 * `profile.ts` needs to resolve an agent-authored profile's service names against. Throws
 * `CatalogMissingError`/`CatalogUnusableError` exactly like `queryCatalog`, same as every other
 * reader of the local index, since there's nothing to derive aliases from until a catalog has been
 * synced.
 */
export function catalogServiceNames(deps: CatalogStoreDeps): string[] {
  const index = requireCurrentIndex(deps);

  const names = new Set<string>();
  for (const record of index) {
    for (const service of record.services) {
      names.add(service);
    }
  }
  return [...names];
}
