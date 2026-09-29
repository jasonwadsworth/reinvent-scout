import type { ApiClient } from "../api/client.js";
import type { Schedule } from "../api/types.js";
import type { IndexRecord } from "../catalog/index-record.js";
import { baseSessionCode, requireCurrentIndex } from "../catalog/query.js";
import { readMeta, readTimezoneAvailability, type CatalogStoreDeps } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import { ValidationError } from "../core/errors.js";
import { deriveSessionTimes } from "./merge.js";
import { validateSessionIds } from "./reservations.js";
import { utcIsoToZonedWallClock } from "./timezone.js";

export interface PlanSelection { requestedId: string; sessionId: string; code: string; title: string; startsAt: string; endsAt: string }
export interface PlanRejection { sessionId: string; reason: string; conflictsWith?: string[] }
export interface SchedulePlan {
  selected: PlanSelection[];
  alreadyReserved: string[];
  /** A requested sitting whose talk is already reserved as a different sitting: the request is
   * not dropped, it is answered by that reservation. */
  alreadyReservedAlternative: Array<{ requested: string; reservedSessionId: string }>;
  rejected: PlanRejection[];
  alternatives: Array<{ requestedId: string; sessionIds: string[] }>;
  blockedBy: string[];
  conflictFree: boolean;
  limitations: string;
}
export interface PlanContext { index: readonly IndexRecord[]; schedule: Schedule; eventTimezone: string | null; now?: () => number }
export interface TimeInterval { startsAt: string; endsAt: string }

/** Reject normalized-overflow dates and missing offsets rather than silently inventing instants. */
function validUtc(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso) && Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().replace(".000Z", "Z") === iso;
}
export function sessionInterval(record: IndexRecord, timezone: string | null): TimeInterval | null {
  if (!timezone || !record.startDate || !record.startTime || !/^\d{4}-\d{2}-\d{2}$/.test(record.startDate) || !/^\d{2}:\d{2}$/.test(record.startTime) || !validUtc(`${record.startDate}T${record.startTime}:00Z`) || record.lengthMinutes === null || !Number.isFinite(record.lengthMinutes) || record.lengthMinutes <= 0) return null;
  try {
    const times = deriveSessionTimes({ ...record, resolved: true }, timezone);
    if (!times.startsAt || !times.endsAt) return null;
    const local = utcIsoToZonedWallClock(times.startsAt, timezone);
    if (local.date !== record.startDate || local.time !== record.startTime) return null;
    return { startsAt: times.startsAt, endsAt: times.endsAt };
  } catch { return null; }
}
export function overlaps(a: TimeInterval, b: TimeInterval): boolean {
  return a.startsAt < b.endsAt && a.endsAt > b.startsAt;
}

/** Deterministic greedy time-only suggestion over the FULL schedule; favorites never block.
 * Existing commitments are not moved, cancelled, or attributed to this invocation. */
export function buildSchedulePlan(input: readonly string[], context: PlanContext): SchedulePlan {
  const ids = validateSessionIds(input, true, false);
  const result: SchedulePlan = { selected: [], alreadyReserved: [], alreadyReservedAlternative: [], rejected: [], alternatives: [], blockedBy: [], conflictFree: true, limitations: "Time non-overlap only; no seat or travel guarantee. Recheck the schedule before reserving." };
  if (ids.length === 0) return result;
  const now = (context.now ?? Date.now)();
  const byId = new Map(context.index.map(record => [record.sessionId, record]));
  const hard: Array<TimeInterval & { id: string }> = [];
  const reservedTalks = new Map<string, string[]>();
  for (const id of context.schedule.reserved) {
    const record = byId.get(id);
    const interval = record ? sessionInterval(record, context.eventTimezone) : null;
    if (!interval) result.blockedBy.push(id);
    else hard.push({ ...interval, id });
    if (record) { const code = baseSessionCode(record); reservedTalks.set(code, [...(reservedTalks.get(code) ?? []), id]); }
  }
  for (const personal of context.schedule.personalTime) {
    const interval = { startsAt: `${personal.startDateTime}Z`, endsAt: `${personal.endDateTime}Z` };
    if (!validUtc(interval.startsAt) || !validUtc(interval.endsAt) || interval.endsAt <= interval.startsAt) result.blockedBy.push(personal.personalTimeId);
    else hard.push({ ...interval, id: personal.personalTimeId });
  }
  if (!context.eventTimezone) result.blockedBy.push("eventTimezone");
  if (result.blockedBy.length) {
    result.conflictFree = false;
    result.rejected = ids.map(sessionId => ({ sessionId, reason: "unknownHardTiming" }));
    return result;
  }
  const selectedTalks = new Set<string>();
  for (const requestedId of ids) {
    const requested = byId.get(requestedId);
    if (!requested) { result.rejected.push({ sessionId: requestedId, reason: "notInCatalog" }); continue; }
    const code = baseSessionCode(requested);
    const reserved = reservedTalks.get(code);
    if (reserved) {
      for (const id of reserved) {
        if (!result.alreadyReserved.includes(id)) result.alreadyReserved.push(id);
        if (id !== requestedId) result.alreadyReservedAlternative.push({ requested: requestedId, reservedSessionId: id });
      }
      continue;
    }
    if (selectedTalks.has(code)) { result.rejected.push({ sessionId: requestedId, reason: "duplicateTalk" }); continue; }
    const alternatives = context.index.filter(record => baseSessionCode(record) === code)
      .map(record => ({ record, interval: sessionInterval(record, context.eventTimezone) }))
      .sort((a, b) => (a.interval?.startsAt ?? "z").localeCompare(b.interval?.startsAt ?? "z") || a.record.sessionId.localeCompare(b.record.sessionId));
    result.alternatives.push({ requestedId, sessionIds: alternatives.map(value => value.record.sessionId) });
    let rejection: PlanRejection = { sessionId: requestedId, reason: "invalidTime" };
    for (const { record, interval } of alternatives) {
      if (!interval) continue;
      if (Date.parse(interval.startsAt) <= now) { rejection = { sessionId: requestedId, reason: "started" }; continue; }
      const conflictsWith = hard.filter(commitment => overlaps(interval, commitment)).map(commitment => commitment.id);
      if (conflictsWith.length) { rejection = { sessionId: requestedId, reason: "conflict", conflictsWith }; continue; }
      result.selected.push({ requestedId, sessionId: record.sessionId, code, title: record.title, ...interval });
      hard.push({ ...interval, id: record.sessionId }); selectedTalks.add(code); break;
    }
    if (!selectedTalks.has(code)) result.rejected.push(rejection);
  }
  return result;
}

/** Catalog event validation precedes the full schedule read. Neither adapter may use a display page. */
export async function planSchedule(ids: readonly string[], deps: CatalogStoreDeps & { apiClient: Pick<ApiClient, "getSchedule">; eventId?: string; now?: () => number }): Promise<SchedulePlan> {
  validateSessionIds(ids, true, false);
  if (!ids.length) return buildSchedulePlan([], { index: [], schedule: { reserved: [], favorites: [], personalTime: [] }, eventTimezone: null });
  const index = requireCurrentIndex(deps);
  const eventId = deps.eventId ?? DEFAULT_EVENT_ID;
  if (readMeta(deps)?.eventId !== eventId) throw new ValidationError(`Sync the catalog for event ${eventId} before planning its schedule.`);
  const timezone = readTimezoneAvailability(deps);
  if (timezone?.status !== "known") throw new ValidationError("Planning requires the event's recognized IANA timezone; sync the event catalog first.");
  const schedule = await deps.apiClient.getSchedule(eventId);
  return buildSchedulePlan(ids, { index, schedule, eventTimezone: timezone.timezone, ...(deps.now ? { now: deps.now } : {}) });
}
