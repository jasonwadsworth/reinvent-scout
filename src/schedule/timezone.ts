/**
 * Converts a session's local wall-clock start time into a real UTC instant, using a genuine IANA
 * timezone conversion -- never the host machine's own timezone (which `new Date("2026-12-01T10:30")`
 * would silently assume) and never a fixed numeric offset (wrong for any zone that observes
 * daylight saving, and wrong in general even for one that doesn't, since it hardcodes a fact about
 * one specific zone into code meant to work for whatever IANA zone `GetEvent` reports).
 */

/** The offset (in milliseconds, `local = utc + offset`) `timeZone` was observing at `utcMs`,
 * found by asking `Intl.DateTimeFormat` what wall-clock time that instant renders as in the zone,
 * then comparing that wall-clock reading (numerically reinterpreted as if it were itself a UTC
 * timestamp) against the real UTC instant it came from. */
function offsetMsAt(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const value: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      value[part.type] = part.value;
    }
  }

  const wallClockAsUtcMs = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second),
  );
  return wallClockAsUtcMs - utcMs;
}

/**
 * Converts a local wall-clock `date` ("YYYY-MM-DD") and `time` ("HH:MM") in `timeZone` to the
 * matching UTC instant, formatted as an ISO-8601 string with a literal `Z` suffix.
 *
 * Standard two-pass fixed-point approach (the same one date-fns-tz's `zonedTimeToUtc` and
 * Luxon's zone conversion use under the hood): a first guess treats the wall-clock numbers as if
 * they were already UTC, computes that guess's real offset in the target zone, and corrects by
 * it; a second pass re-derives the offset at the corrected instant and corrects again, which
 * converges to the right answer even right around a DST transition (the only case where the
 * offset at the first guess and the offset at the true answer can differ).
 */
export function zonedWallClockToUtcIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const offset1 = offsetMsAt(naiveUtcMs, timeZone);
  const candidateMs = naiveUtcMs - offset1;
  const offset2 = offsetMsAt(candidateMs, timeZone);
  const resultMs = naiveUtcMs - offset2;

  return new Date(resultMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Adds whole minutes to a UTC ISO-8601 instant (as produced by `zonedWallClockToUtcIso`, or a
 * `PersonalTime` field already in UTC), returning the same `...Z`-suffixed shape. */
export function addMinutesToIso(iso: string, minutes: number): string {
  const resultMs = new Date(iso).getTime() + minutes * 60_000;
  return new Date(resultMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The inverse of `zonedWallClockToUtcIso`: renders a UTC instant as the wall-clock date and time
 * an attendee in `timeZone` would actually see, split into `date` ("YYYY-MM-DD") and `time`
 * ("HH:MM"). Used wherever a value that's only ever stored in UTC (a personal-time block's own
 * `startDateTime`/`endDateTime`) needs to be shown the same way a session's already-local
 * `startDate`/`startTime` is -- reviewer's finding: printing personal time in raw UTC right next
 * to session times in event-local time made a block that's actually mid-afternoon local time look
 * like it fell after midnight the next day.
 */
export function utcIsoToZonedWallClock(iso: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));

  const value: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      value[part.type] = part.value;
    }
  }

  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}
