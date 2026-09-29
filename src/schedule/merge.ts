import type { PersonalTime } from "../api/types.js";
import type { TimezoneAvailability } from "../catalog/store.js";
import { addMinutesToIso, zonedWallClockToUtcIso } from "./timezone.js";
import type { ScheduleResult, ScheduleSession } from "./schedule.js";

/**
 * Merges `reserved`, `favorites` and `personalTime` into one genuinely time-ordered list, and
 * derives each entry's `startsAt`/`endsAt` (a real UTC instant) via a genuine IANA conversion in
 * the event's own timezone -- shared between the `get_schedule` MCP tool and the CLI's `schedule
 * show`, so both order and label a schedule identically rather than carrying two independent
 * (and, before this module existed, actually divergent) implementations of the same logic.
 */

export type ScheduleEntryKind = "reserved" | "favorite" | "personalTime";

export interface MergedScheduleEntry {
  kind: ScheduleEntryKind;
  /** A real UTC instant (ISO-8601, `Z`-suffixed), directly comparable across every entry
   * regardless of kind -- the primary sort key. `null` when it cannot be computed: for a session,
   * either because the event's own timezone is unknown (`eventTimezone` was `null`) or because
   * the session itself has no fully-resolved date and time. Personal time always has a real
   * `startsAt`, since its own `startDateTime` is UTC and required -- never `null`, unlike a
   * session's. */
  startsAt: string | null;
  /** `null` under the same conditions as `startsAt`, except for a resolved session with no known
   * `lengthMinutes` -- personal time always has a real `endsAt`. */
  endsAt: string | null;
  /** `null` for an unscheduled or unresolved session, which sorts last -- personal time is never
   * in this state, since `startDateTime` is a required field on it. Used only as a fallback level
   * below `startsAt`, for ordering entries that share a `null` startsAt (which only ever happens
   * among sessions) against each other by their own raw local date/time. */
  sortDate: string | null;
  sortTime: string | null;
  /** `sessionId` for a reserved/favorite entry, `personalTimeId` for personal time -- always
   * present and, within one merged list, unique, which is what makes the final sort level below a
   * genuine total order rather than a partial one. */
  tiebreaker: string;
  /** Present (non-`null`) only when `kind` is `"reserved"` or `"favorite"`. */
  session: ScheduleSession | null;
  /** Present (non-`null`) only when `kind` is `"personalTime"`. */
  personalTime: PersonalTime | null;
}

/** Derives a resolved session's `startsAt`/`endsAt` from its local `startDate`/`startTime` (and
 * `lengthMinutes`, for `endsAt`) via a real IANA conversion in `eventTimezone` -- `null` for
 * either when `eventTimezone` itself is unknown, the session isn't fully scheduled, or (for
 * `endsAt` only) its length isn't known. Never falls back to the host machine's timezone or a
 * hardcoded offset: when `eventTimezone` is `null`, this returns `{ startsAt: null, endsAt: null }`
 * outright rather than guessing. */
export function deriveSessionTimes(
  session: ScheduleSession,
  eventTimezone: string | null,
): { startsAt: string | null; endsAt: string | null } {
  if (eventTimezone === null || !session.resolved || session.startDate === null || session.startTime === null) {
    return { startsAt: null, endsAt: null };
  }
  const startsAt = zonedWallClockToUtcIso(session.startDate, session.startTime, eventTimezone);
  const endsAt = session.lengthMinutes === null ? null : addMinutesToIso(startsAt, session.lengthMinutes);
  return { startsAt, endsAt };
}

function toSessionEntry(
  session: ScheduleSession,
  kind: "reserved" | "favorite",
  eventTimezone: string | null,
): MergedScheduleEntry {
  const { startsAt, endsAt } = deriveSessionTimes(session, eventTimezone);
  return {
    kind,
    startsAt,
    endsAt,
    sortDate: session.resolved ? session.startDate : null,
    sortTime: session.resolved ? session.startTime : null,
    tiebreaker: session.sessionId,
    session,
    personalTime: null,
  };
}

function toPersonalTimeEntry(entry: PersonalTime): MergedScheduleEntry {
  // "YYYY-MM-DDTHH:MM:SS" -- splitting on the literal separator this field's own format
  // guarantees, not parsing it as a Date, matches how index-record.ts and the rest of this
  // codebase avoid ever assuming a timezone the API doesn't actually provide. The field is
  // already UTC (per its own doc comment in api/types.ts), so startsAt/endsAt need only the
  // literal `Z` suffix appended, no conversion.
  const [date, time] = entry.startDateTime.split("T");
  const startsAt = `${entry.startDateTime}Z`;
  const endsAt = `${entry.endDateTime}Z`;
  return {
    kind: "personalTime",
    startsAt,
    endsAt,
    sortDate: date ?? null,
    sortTime: time ?? null,
    tiebreaker: entry.personalTimeId,
    session: null,
    personalTime: entry,
  };
}

/** Any real string sorts before `null` at this level -- used for both the date and time
 * comparisons below, since an entry with no known date (unresolved, or the API never scheduled
 * it) or a resolved entry with a date but a genuinely unknown time must both fall after anything
 * with a known value at that level, not before it. */
function compareNullableLast(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a.localeCompare(b);
}

/**
 * A genuine total order -- `startsAt` (a real UTC instant, directly comparable across kinds),
 * then the raw local date and time as a fallback for entries sharing a `null` startsAt, then
 * `kind`, then `tiebreaker` -- so two entries are never merely "tied" the way a comparator
 * stopping at date+time would leave them. `startsAt` before the raw date/time fallback is what
 * makes a personal-time block (always a real UTC instant) sort correctly against a session near a
 * day boundary even when the session's own local date, read as a bare string, would suggest the
 * opposite order. The fallback level only ever compares entries that both have a `null` startsAt,
 * which only happens among sessions, so it can never wrongly reorder a session relative to
 * personal time; it exists purely to keep same-day sessions sensibly ordered against each other
 * when the event's timezone (or an individual session's own time) is unknown.
 */
function compareMergedEntries(a: MergedScheduleEntry, b: MergedScheduleEntry): number {
  const byStartsAt = compareNullableLast(a.startsAt, b.startsAt);
  if (byStartsAt !== 0) {
    return byStartsAt;
  }
  const byDate = compareNullableLast(a.sortDate, b.sortDate);
  if (byDate !== 0) {
    return byDate;
  }
  const byTime = compareNullableLast(a.sortTime, b.sortTime);
  if (byTime !== 0) {
    return byTime;
  }
  if (a.kind !== b.kind) {
    return a.kind.localeCompare(b.kind);
  }
  return a.tiebreaker.localeCompare(b.tiebreaker);
}

/** Merges `reserved`, `favorites` and `personalTime` into one list, sorted by `compareMergedEntries`. */
export function mergeAndSortScheduleEntries(
  result: Pick<ScheduleResult, "reserved" | "favorites" | "personalTime">,
  eventTimezone: string | null,
): MergedScheduleEntry[] {
  const merged = [
    ...result.reserved.map((session) => toSessionEntry(session, "reserved", eventTimezone)),
    ...result.favorites.map((session) => toSessionEntry(session, "favorite", eventTimezone)),
    ...result.personalTime.map(toPersonalTimeEntry),
  ];
  return merged.sort(compareMergedEntries);
}

/** The `startsAt`/`endsAt`-relevant warnings for the event's timezone availability -- `[]` when
 * it's known, or when nothing has ever been synced at all (a caller's own "no catalog" warning
 * already covers that case with its own remedy). The two `"unavailable"` reasons need genuinely
 * different advice, not one generic message for both: a pre-timezone-support catalog (no
 * `timezone` key at all) is fixed by one more `catalog sync`, while an explicit `null` (`GetEvent`'s
 * response genuinely omitted it) cannot be fixed by syncing again at all -- telling a caller the
 * unfixable story in both cases would say nothing can be done when a sync would actually solve it.
 * Shared verbatim between `get_schedule` and `schedule show`, so a person and an agent are told the
 * exact same thing about the exact same condition. */
export function timezoneWarnings(availability: TimezoneAvailability | null): string[] {
  if (availability === null || availability.status === "known") {
    return [];
  }
  if (availability.status === "unrecognized") {
    return [
      `The stored event timezone (${JSON.stringify(availability.value)}) is not a recognized ` +
        "IANA timezone, so session start times could not be converted to a common startsAt -- " +
        "session and personal-time ordering across kinds is unreliable. Re-syncing " +
        "(`catalog_sync`, or `reinvent-scout catalog sync`) may resolve this, but is not " +
        "guaranteed to: if the API reports the same value again, syncing again will not help.",
    ];
  }
  if (availability.reason === "syncedBeforeTimezoneSupport") {
    return [
      "This catalog was synced before timezone support was added, so session start times " +
        "could not be converted to a common startsAt -- session and personal-time ordering " +
        "across kinds is unreliable. Run `catalog_sync` (or `reinvent-scout catalog sync`) to " +
        "fetch the event's timezone; it will very likely resolve this.",
    ];
  }
  return [
    "The event's timezone is unknown (GetEvent's response omitted it), so session start times " +
      "could not be converted to a common startsAt -- session and personal-time ordering across " +
      "kinds is unreliable. Sessions still sort correctly relative to each other by their local " +
      "date and time.",
  ];
}
