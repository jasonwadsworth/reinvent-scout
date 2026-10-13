import { ValidationError } from "../core/errors.js";
import { OUTPUT_BUDGET_BYTES, outputBytes, shortenDescription } from "../commands/output-budget.js";
import { deriveSessionTimes, timezoneWarnings } from "../schedule/merge.js";
import type { IndexRecord } from "./index-record.js";
import { baseSessionCode, compareByStartDateTime, requireCurrentIndex, resolveSessionToken } from "./query.js";
import { readRaw, readTimezoneAvailability, type CatalogStoreDeps } from "./store.js";
import type { Venue } from "./venue.js";

export const LOOKUP_MAX_IDS = 100;
export const LOOKUP_MAX_ABSTRACT_IDS = 10;
/** Short enough that even 100 queries of 3-byte characters, all echoed back, fit the output budget. */
export const LOOKUP_MAX_QUERY_LENGTH = 64;
const MAX_TITLE = 200;
const MAX_ABSTRACT = 1500;
const MAX_OTHER_SITTINGS = 5;
const MAX_AMBIGUOUS_IDS = 10;

export interface LookupInput {
  /** Session ids or codes (`ARC330`, `ARC330-R1`). */
  ids: readonly string[];
  includeAbstract?: boolean | undefined;
}
export interface LookupDeps extends CatalogStoreDeps {
  /** Reads the local index; defaults to `requireCurrentIndex`. Injected so a test can count reads. */
  readIndexFn?: (deps: CatalogStoreDeps) => IndexRecord[];
}
export interface OtherSitting { sessionId: string; code: string | null; startDate: string | null; startTime: string | null; venue: Venue | null; room: string | null }
export interface LookupRow {
  query: string;
  sessionId: string;
  code: string | null;
  title: string;
  type: string | null;
  level: string | null;
  venue: Venue | null;
  room: string | null;
  startDate: string | null;
  startTime: string | null;
  endTime: string | null;
  /** UTC instants; null when the event timezone is unknown. */
  startsAt: string | null;
  endsAt: string | null;
  otherSittings: OtherSitting[];
  abstract?: string;
}
export interface LookupResult {
  rows: LookupRow[];
  notFound: string[];
  ambiguous: Array<{ query: string; sessionIds: string[] }>;
  /** Queries cut to keep the output within its budget; ask for them again. */
  notReturned: string[];
  warnings?: string[];
}

function validateLookupInput(input: LookupInput): string[] {
  const ids = [...new Set(input.ids.map(id => (typeof id === "string" ? id.trim() : id)))];
  if (ids.length < 1 || ids.length > LOOKUP_MAX_IDS || ids.some(id => typeof id !== "string" || id.length === 0 || Array.from(id).length > LOOKUP_MAX_QUERY_LENGTH)) {
    throw new ValidationError(`Expected 1–${LOOKUP_MAX_IDS} ids or codes, each 1–${LOOKUP_MAX_QUERY_LENGTH} characters.`);
  }
  if (input.includeAbstract === true && ids.length > LOOKUP_MAX_ABSTRACT_IDS) {
    throw new ValidationError(`Abstracts are returned for at most ${LOOKUP_MAX_ABSTRACT_IDS} ids at a time.`);
  }
  return ids;
}

/** The other sittings of the same talk (same base code), earliest first, whichever form the caller looked it up by. */
function otherSittingsOf(index: readonly IndexRecord[], record: IndexRecord): IndexRecord[] {
  const code = baseSessionCode(record).toLowerCase();
  return index.filter(other => other.sessionId !== record.sessionId && baseSessionCode(other).toLowerCase() === code).sort(compareByStartDateTime).slice(0, MAX_OTHER_SITTINGS);
}

function endTimeOf(record: IndexRecord): string | null {
  if (record.startTime === null || record.lengthMinutes === null) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(record.startTime);
  if (!match) return null;
  const total = (Number(match[1]) * 60 + Number(match[2]) + record.lengthMinutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Resolves session ids and codes against the local index, which is read once for the whole call.
 * Every requested query lands in exactly one of `rows`, `notFound`, `ambiguous` or `notReturned`:
 * nothing is silently dropped, including queries cut to stay within the output budget.
 */
export function lookupSessions(input: LookupInput, deps: LookupDeps): LookupResult {
  const ids = validateLookupInput(input);
  const index = (deps.readIndexFn ?? requireCurrentIndex)(deps);
  const availability = readTimezoneAvailability(deps);
  const timezone = availability?.status === "known" ? availability.timezone : null;
  const rawById = input.includeAbstract === true ? new Map((readRaw(deps) ?? []).map(session => [session.sessionId, session])) : null;
  const result: LookupResult = { rows: [], notFound: [], ambiguous: [], notReturned: [] };
  for (const query of ids) {
    const resolved = resolveSessionToken(index, query);
    if (resolved.status === "not-found") { result.notFound.push(query); continue; }
    if (resolved.status === "ambiguous") {
      result.ambiguous.push({ query, sessionIds: resolved.candidates.slice(0, MAX_AMBIGUOUS_IDS).map(record => record.sessionId) });
      continue;
    }
    const record = resolved.record;
    const { startsAt, endsAt } = deriveSessionTimes({ sessionId: record.sessionId, resolved: true, title: record.title, abbreviation: record.abbreviation, startDate: record.startDate, startTime: record.startTime, lengthMinutes: record.lengthMinutes, venue: record.venue, room: record.room }, timezone);
    const abstract = rawById?.get(record.sessionId)?.abstract;
    result.rows.push({
      query, sessionId: record.sessionId, code: record.abbreviation, title: shortenDescription(record.title, MAX_TITLE),
      type: record.type, level: record.level, venue: record.venue, room: record.room,
      startDate: record.startDate, startTime: record.startTime, endTime: endTimeOf(record), startsAt, endsAt,
      otherSittings: otherSittingsOf(index, record).map(other => ({ sessionId: other.sessionId, code: other.abbreviation, startDate: other.startDate, startTime: other.startTime, venue: other.venue, room: other.room })),
      ...(abstract === undefined ? {} : { abstract: shortenDescription(abstract, MAX_ABSTRACT) }),
    });
  }
  const warnings = timezone === null ? timezoneWarnings(availability) : [];
  if (warnings.length > 0) result.warnings = warnings;
  // Whole entries go, never part of one: rows first, then ambiguous entries.
  while (outputBytes(result) > OUTPUT_BUDGET_BYTES && result.rows.length > 0) {
    result.notReturned.unshift(result.rows.pop()!.query);
  }
  while (outputBytes(result) > OUTPUT_BUDGET_BYTES && result.ambiguous.length > 0) {
    result.notReturned.unshift(result.ambiguous.pop()!.query);
  }
  return result;
}
