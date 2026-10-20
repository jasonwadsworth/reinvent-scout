import { OUTPUT_BUDGET_BYTES, outputBytes, shortenDescription } from "../commands/output-budget.js";
import { queryCatalog, type LevelBandRange } from "./query.js";
import type { CatalogStoreDeps } from "./store.js";
import type { Venue } from "./venue.js";

export const DEFAULT_SEARCH_LIMIT = 15;
export const MAX_SEARCH_LIMIT = 25;
const MAX_TITLE = 160;

export interface SearchInput {
  query?: string;
  /** The session type, e.g. "Chalk talk". */
  format?: string;
  venue?: Venue;
  levels?: LevelBandRange;
  /** `YYYY-MM-DD`. */
  day?: string;
  limit?: number;
}
export interface SearchRow {
  sessionId: string;
  code: string | null;
  title: string;
  type: string | null;
  level: string | null;
  venue: Venue | null;
  startDate: string | null;
  startTime: string | null;
  score: number;
}
export interface SearchResult {
  rows: SearchRow[];
  /** Matches left out to stay within the output budget (the limit already caps the rest). */
  omitted: number;
}

/** A thin, budgeted adapter over `queryCatalog`: lean rows, never an abstract or a term map. */
export function searchSessions(input: SearchInput, deps: CatalogStoreDeps): SearchResult {
  const limit = Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const results = queryCatalog(deps, {
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.format === undefined ? {} : { type: input.format }),
    ...(input.venue === undefined ? {} : { venue: input.venue }),
    ...(input.levels === undefined ? {} : { levelBand: input.levels }),
    ...(input.day === undefined ? {} : { day: input.day }),
    limit,
  });
  const result: SearchResult = {
    rows: results.map(({ record, score }) => ({ sessionId: record.sessionId, code: record.abbreviation, title: shortenDescription(record.title, MAX_TITLE), type: record.type, level: record.level, venue: record.venue, startDate: record.startDate, startTime: record.startTime, score })),
    omitted: 0,
  };
  while (outputBytes(result) > OUTPUT_BUDGET_BYTES && result.rows.length > 0) {
    result.rows.pop();
    result.omitted++;
  }
  return result;
}
