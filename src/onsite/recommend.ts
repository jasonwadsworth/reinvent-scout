import { z } from "zod";
import type { ApiClient } from "../api/client.js";
import type { Schedule, Session } from "../api/types.js";
import { buildIndexRecord, type IndexRecord } from "../catalog/index-record.js";
import { requireCurrentIndex } from "../catalog/query.js";
import { readMeta, readRaw, readTimezoneAvailability } from "../catalog/store.js";
import { DEFAULT_EVENT_ID } from "../catalog/sync.js";
import { isKnownVenue, VENUES, type Venue } from "../catalog/venue.js";
import { AuthRequiredError, NotRegisteredError, ThrottledError, ValidationError } from "../core/errors.js";
import { overlaps, sessionInterval, type TimeInterval } from "../schedule/plan.js";
import { effectiveOnsitePreferences, readOnsiteConfig, walkUpAllowed, type OnsitePreferences } from "./config.js";
import { estimateTravel, type TravelEstimate } from "./travel.js";

export const MAX_NEARBY_REFRESH = 20;
export const nearbyInputSchema = z.strictObject({
  eventId: z.string().min(1).max(128).optional(),
  location: z.strictObject({ venue: z.enum(VENUES), source: z.enum(["user", "location", "schedule"]), confirmed: z.boolean() }).optional(),
  skipSessionIds: z.array(z.string().min(1).max(128)).max(50).optional(),
  withinMinutes: z.number().int().min(1).max(240).optional(), limit: z.number().int().min(1).max(20).optional(),
});
export type NearbyInput = z.infer<typeof nearbyInputSchema>;
export interface NearbyCandidate extends TimeInterval {
  sessionId: string; title: string; venue: Venue; reserved: boolean;
  availability: string; availabilitySource: "live" | "cache"; observedAt: number | null; ageMinutes: number | null; minutesToStart: number;
  admission: string; outbound: TravelEstimate; onward?: TravelEstimate; nextCommitmentId?: string;
}
export interface NearbyResult {
  needsVenueConfirmation: boolean; suggestedVenue?: Venue; candidates: NearbyCandidate[];
  rejected: Array<{ reason: string; count: number }>; warnings: string[]; limitations: string;
  coverage: { examined: number; eligible: number; refreshAttempts: number; refreshed: number; unrefreshed: number; refreshStopped: boolean; omitted: number };
}
export interface NearbyDeps {
  storeRoot: string; apiClient: Pick<ApiClient, "getSchedule" | "getSession">; now?: () => number;
}
interface Commitment { kind: "reserved" | "personal"; id: string; interval: TimeInterval | null; venue: Venue | null }
function commitments(index: readonly IndexRecord[], schedule: Schedule, timezone: string, skips: Set<string>): Commitment[] {
  const byId = new Map(index.map(record => [record.sessionId, record]));
  const hard: Commitment[] = schedule.reserved.filter(id => !skips.has(id)).map(id => {
    const record = byId.get(id);
    return { kind: "reserved", id, interval: record ? sessionInterval(record, timezone) : null, venue: record?.venue ?? null };
  });
  for (const p of schedule.personalTime) {
    const start = `${p.startDateTime}Z`, end = `${p.endDateTime}Z`;
    const valid = (s: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().replace(".000Z", "Z") === s;
    hard.push({ kind: "personal", id: p.personalTimeId, interval: valid(start) && valid(end) && start < end ? { startsAt: start, endsAt: end } : null, venue: p.location && isKnownVenue(p.location) ? p.location : null });
  }
  return hard;
}
function feasible(record: IndexRecord, allDay: boolean, context: { now: number; horizon: number; from: Venue; timezone: string; prefs: OnsitePreferences; hard: Commitment[] }): { interval: TimeInterval; outbound: TravelEstimate; onward?: TravelEstimate; nextCommitmentId?: string } | string {
  const { now, horizon, from, timezone, prefs, hard } = context;
  const interval = sessionInterval(record, timezone);
  if (allDay || !interval || !record.venue || Date.parse(interval.startsAt) <= now || Date.parse(interval.startsAt) > horizon) return "outsideWindowOrUnknownTimeVenue";
  const others = hard.filter(c => c.kind !== "reserved" || c.id !== record.sessionId);
  if (others.some(c => !c.interval)) return "unknownHardTiming";
  // An ongoing/intervening commitment cannot be silently abandoned on the way out.
  if (others.some(c => c.interval && (overlaps(interval, c.interval) || (Date.parse(c.interval.endsAt) > now && c.interval.startsAt < interval.startsAt)))) return "hardCommitmentConflict";
  const outbound = estimateTravel(from, record.venue, now, timezone, prefs);
  if (now + (outbound.totalMinutes + outbound.checkInMinutes) * 60_000 > Date.parse(interval.startsAt)) return "outboundTravel";
  const next = others.filter(c => c.interval && c.interval.startsAt >= interval.endsAt).sort((a, b) => a.interval!.startsAt.localeCompare(b.interval!.startsAt))[0];
  if (!next) return { interval, outbound };
  if (!next.venue) return "unknownNextVenue";
  const onward = estimateTravel(record.venue, next.venue, Date.parse(interval.endsAt), timezone, prefs);
  if (Date.parse(interval.endsAt) + (onward.totalMinutes + onward.checkInMinutes) * 60_000 > Date.parse(next.interval!.startsAt)) return "onwardTravel";
  return { interval, outbound, onward, nextCommitmentId: next.id };
}
export async function recommendNearbySessions(input: NearbyInput, deps: NearbyDeps): Promise<NearbyResult> {
  const parsed = nearbyInputSchema.parse(input);
  const now = (deps.now ?? Date.now)();
  const result: NearbyResult = { needsVenueConfirmation: !parsed.location?.confirmed, candidates: [], rejected: [], warnings: [], limitations: "Travel times are conservative assumptions, not live routing. Availability bands are not seat counts; admission and arrival are not guaranteed. No reservations are changed.", coverage: { examined: 0, eligible: 0, refreshAttempts: 0, refreshed: 0, unrefreshed: 0, refreshStopped: false, omitted: 0 } };
  const index = requireCurrentIndex(deps), meta = readMeta(deps);
  const eventId = parsed.eventId ?? DEFAULT_EVENT_ID;
  if (meta?.eventId !== eventId) throw new ValidationError(`Sync the catalog for event ${eventId} before nearby recommendations.`);
  const zone = readTimezoneAvailability(deps);
  if (zone?.status !== "known") throw new ValidationError("Nearby recommendations require the event's recognized IANA timezone.");
  const schedule = await deps.apiClient.getSchedule(eventId);
  const prefs = effectiveOnsitePreferences(readOnsiteConfig(deps), eventId);
  const skips = new Set(parsed.skipSessionIds ?? []);
  const hard = commitments(index, schedule, zone.timezone, skips);
  if (result.needsVenueConfirmation) {
    const recent = hard.filter(c => c.interval && Date.parse(c.interval.startsAt) <= now && Date.parse(c.interval.endsAt) >= now - 60 * 60_000).sort((a, b) => b.interval!.endsAt.localeCompare(a.interval!.endsAt))[0];
    if (recent?.venue) result.suggestedVenue = recent.venue;
    result.warnings.push("Confirm your current venue for this call before receiving recommendations."); return result;
  }
  if (skips.size) result.warnings.push("Explicit skips affect this recommendation only and do not cancel any reservation.");
  const unknownHard = hard.find(c => !c.interval);
  if (unknownHard) result.warnings.push(`Cannot establish hard commitment timing: ${unknownHard.id.slice(0, 128)}. Resolve it before relying on nearby suggestions.`);
  const counts = new Map<string, number>();
  const reject = (reason: string) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const context = { now, horizon: now + (parsed.withinMinutes ?? 60) * 60_000, from: parsed.location!.venue, timezone: zone.timezone, prefs, hard };
  const raw = new Map((readRaw(deps) ?? []).map(s => [s.sessionId, s]));
  const eligible = [...new Map(index.map(record => [record.sessionId, record])).values()].filter(record => { const check = feasible(record, raw.get(record.sessionId)?.isAllDaySession === true, context); if (typeof check === "string") { reject(check); return false; } return true; }).sort((a, b) => Number(schedule.reserved.includes(b.sessionId)) - Number(schedule.reserved.includes(a.sessionId)) || (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.sessionId.localeCompare(b.sessionId));
  result.coverage.examined = index.length; result.coverage.eligible = eligible.length;
  const evaluatedRecords = new Map<string, IndexRecord>();
  for (const cached of eligible.slice(0, MAX_NEARBY_REFRESH)) {
    let record = cached, allDay = raw.get(cached.sessionId)?.isAllDaySession === true;
    let source: "live" | "cache" = "cache", observedAt = Number.isFinite(meta.syncedAt) ? meta.syncedAt : null;
    if (!result.coverage.refreshStopped) {
      result.coverage.refreshAttempts++;
      try {
        const fresh: Session = await deps.apiClient.getSession(eventId, cached.sessionId);
        if (!fresh || fresh.sessionId !== cached.sessionId) throw new Error("Unexpected session identity");
        record = buildIndexRecord(fresh); allDay = fresh.isAllDaySession === true;
        source = "live"; observedAt = (deps.now ?? Date.now)(); result.coverage.refreshed++;
      } catch (err) {
        if (err instanceof AuthRequiredError || err instanceof NotRegisteredError || err instanceof ThrottledError) result.coverage.refreshStopped = true;
      }
    }
    const evaluatedAt = (deps.now ?? Date.now)();
    const route = feasible(record, allDay, { ...context, now: evaluatedAt }); if (typeof route === "string") { reject(route); continue; }
    const fresh = source === "live" && observedAt !== null && observedAt <= evaluatedAt && evaluatedAt - observedAt <= prefs.freshnessMinutes * 60_000;
    const availability = fresh && ["available", "limited", "veryLimited", "unavailable", "walkUp"].includes(record.seatAvailability ?? "") ? record.seatAvailability! : "unknown";
    const reserved = schedule.reserved.includes(record.sessionId);
    if (!reserved && (availability === "unavailable" || ((availability === "unknown" || availability === "walkUp") && !walkUpAllowed(prefs, record.sessionId)))) { reject("admissionNotAllowed"); continue; }
    evaluatedRecords.set(record.sessionId, record);
    result.candidates.push({ sessionId: record.sessionId, title: record.title, venue: record.venue!, reserved, ...route.interval, outbound: route.outbound, ...(route.onward ? { onward: route.onward, nextCommitmentId: route.nextCommitmentId! } : {}), availability, availabilitySource: source, observedAt, ageMinutes: observedAt !== null && observedAt <= evaluatedAt ? (evaluatedAt - observedAt) / 60_000 : null, minutesToStart: (Date.parse(route.interval.startsAt) - evaluatedAt) / 60_000, admission: reserved ? "Already reserved; check in on time." : availability === "unknown" ? (record.isReservable === false ? "No reservation offered; admission unknown. Confirm on site." : "Admission unknown; confirm on site.") : availability === "walkUp" ? "Walk-up only; no admission guarantee." : `Reported ${availability}; a reservation or on-site confirmation may still be required.` });
  }
  const completedAt = (deps.now ?? Date.now)();
  result.candidates = result.candidates.filter(candidate => {
    const route = feasible(evaluatedRecords.get(candidate.sessionId)!, false, { ...context, now: completedAt });
    if (typeof route === "string") { reject(route); return false; }
    candidate.outbound = route.outbound;
    if (route.onward) candidate.onward = route.onward;
    candidate.minutesToStart = (Date.parse(candidate.startsAt) - completedAt) / 60_000;
    candidate.ageMinutes = candidate.observedAt !== null && candidate.observedAt <= completedAt ? (completedAt - candidate.observedAt) / 60_000 : null;
    if (candidate.ageMinutes === null || candidate.ageMinutes > prefs.freshnessMinutes) {
      candidate.availability = "unknown";
      if (!candidate.reserved) {
        if (!walkUpAllowed(prefs, candidate.sessionId)) { reject("admissionNotAllowed"); return false; }
        candidate.admission = "Admission unknown; confirm on site.";
      }
    }
    return true;
  });
  result.rejected = Array.from(counts, ([reason, count]) => ({ reason, count }));
  result.coverage.unrefreshed = eligible.length - result.coverage.refreshed;
  if (result.coverage.unrefreshed) result.warnings.push("Some local candidates were not refreshed. Cached bands retain their original observation time; coverage is limited to the local prefilter and at most 20 serial reads.");
  result.candidates.sort((a, b) => Number(b.reserved) - Number(a.reserved) || Number(a.availability === "unknown") - Number(b.availability === "unknown") || a.outbound.totalMinutes - b.outbound.totalMinutes || a.startsAt.localeCompare(b.startsAt) || a.sessionId.localeCompare(b.sessionId));
  result.coverage.omitted = Math.max(0, result.candidates.length - (parsed.limit ?? 10)); result.candidates = result.candidates.slice(0, parsed.limit ?? 10);
  return result;
}
