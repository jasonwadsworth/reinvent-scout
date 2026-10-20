/** Session start and end instants, and the warnings that say when they cannot be computed. */

import type { TimezoneAvailability } from "../catalog/store.js";
import type { Venue } from "../catalog/venue.js";
import { addMinutesToIso, zonedWallClockToUtcIso } from "./timezone.js";

/** One session of a schedule that resolved against the local catalog index. */
export interface ResolvedScheduleSession {
  sessionId: string;
  resolved: true;
  title: string;
  abbreviation: string | null;
  startDate: string | null;
  startTime: string | null;
  /** Minutes, from the index record's own `lengthMinutes` -- used with `startDate`/`startTime`
   * and the event's timezone to derive the session's `endsAt`. `null` when the source event
   * doesn't supply a length, same as an unscheduled session's null date/time. */
  lengthMinutes: number | null;
  venue: Venue | null;
  room: string | null;
}

/** One session of a schedule that the local catalog index has no record for -- most often
 * because it was imported after the last catalog import, or because nothing has ever been
 * imported at all. Kept, not dropped. */
export interface UnresolvedScheduleSession {
  sessionId: string;
  resolved: false;
}

export type ScheduleSession = ResolvedScheduleSession | UnresolvedScheduleSession;

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

/** The `startsAt`/`endsAt`-relevant warnings for the event's timezone availability -- `[]` when
 * it's known, or when nothing has ever been imported at all (the "no catalog" error already
 * covers that case with its own remedy). The two `"unavailable"` reasons need genuinely
 * different advice, not one generic message for both: a pre-timezone-support catalog (no
 * `timezone` key at all) is fixed by one more import with the catalog-sync agent, while an
 * explicit `null` (`GetEvent`'s response genuinely omitted it) cannot be fixed by importing again
 * at all -- telling a caller the unfixable story in both cases would say nothing can be done
 * when an import would actually solve it. */
export function timezoneWarnings(availability: TimezoneAvailability | null): string[] {
  if (availability === null || availability.status === "known") {
    return [];
  }
  if (availability.status === "unrecognized") {
    return [
      `The stored event timezone (${JSON.stringify(availability.value)}) is not a recognized ` +
        "IANA timezone, so `startsAt` and `endsAt` could not be computed. Re-importing with the " +
        "catalog-sync agent may resolve this, but is not guaranteed to: if `GetEvent` reports " +
        "the same value again, importing again will not help.",
    ];
  }
  if (availability.reason === "syncedBeforeTimezoneSupport") {
    return [
      "This catalog was imported before timezone support was added, so `startsAt` and " +
        "`endsAt` could not be computed. Re-import it with the catalog-sync agent; that will " +
        "very likely resolve this.",
    ];
  }
  return [
    "The event's timezone is unknown (GetEvent's response omitted it), so `startsAt` and " +
      "`endsAt` could not be computed. Local dates and times are still correct.",
  ];
}
