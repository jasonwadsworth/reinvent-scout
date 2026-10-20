import { describe, expect, it } from "vitest";
import type { TimezoneAvailability } from "../../src/catalog/store.js";
import { deriveSessionTimes, timezoneWarnings } from "../../src/schedule/session-times.js";
import type { ResolvedScheduleSession, ScheduleSession } from "../../src/schedule/session-times.js";

function resolvedSession(overrides: Partial<ResolvedScheduleSession> & { sessionId: string }): ScheduleSession {
  return {
    resolved: true,
    title: "Untitled",
    abbreviation: null,
    startDate: null,
    startTime: null,
    lengthMinutes: null,
    venue: null,
    room: null,
    ...overrides,
  };
}

describe("deriveSessionTimes", () => {
  const session = resolvedSession({ sessionId: "s", startDate: "2026-12-01", startTime: "10:00", lengthMinutes: 60 });

  it("converts the local start and adds the length, in the event's own timezone", () => {
    expect(deriveSessionTimes(session, "America/Los_Angeles")).toEqual({ startsAt: "2026-12-01T18:00:00Z", endsAt: "2026-12-01T19:00:00Z" });
  });

  it("has no instants when the timezone is unknown, however complete the session is", () => {
    expect(deriveSessionTimes(session, null)).toEqual({ startsAt: null, endsAt: null });
  });

  it("has no instants for an unresolved or unscheduled session, and no end without a length", () => {
    expect(deriveSessionTimes({ sessionId: "u", resolved: false }, "America/Los_Angeles")).toEqual({ startsAt: null, endsAt: null });
    expect(deriveSessionTimes(resolvedSession({ sessionId: "s" }), "America/Los_Angeles")).toEqual({ startsAt: null, endsAt: null });
    expect(deriveSessionTimes(resolvedSession({ sessionId: "s", startDate: "2026-12-01", startTime: "10:00" }), "America/Los_Angeles")).toEqual({ startsAt: "2026-12-01T18:00:00Z", endsAt: null });
  });
});

describe("timezoneWarnings", () => {
  it("is empty when the timezone is known", () => {
    expect(timezoneWarnings({ status: "known", timezone: "America/Los_Angeles" })).toEqual([]);
  });

  it("is empty when nothing has ever been synced", () => {
    expect(timezoneWarnings(null)).toEqual([]);
  });

  it("names the unrecognized stored value", () => {
    const availability: TimezoneAvailability = { status: "unrecognized", value: "Not/AZone" };
    const [warning] = timezoneWarnings(availability);
    expect(warning).toMatch(/"Not\/AZone"/);
    expect(warning).toMatch(/not a recognized/i);
  });

  it("tells a pre-timezone-support catalog that a re-sync will very likely fix it", () => {
    const availability: TimezoneAvailability = { status: "unavailable", reason: "syncedBeforeTimezoneSupport" };
    const [warning] = timezoneWarnings(availability);
    expect(warning).toMatch(/very likely resolve/i);
  });

  it("names the catalog-sync agent as the remedy, never a removed command", () => {
    const cases: Array<[TimezoneAvailability, boolean]> = [
      [{ status: "unrecognized", value: "Not/AZone" }, true],
      [{ status: "unavailable", reason: "syncedBeforeTimezoneSupport" }, true],
      [{ status: "unavailable", reason: "omittedByApi" }, false],
    ];
    for (const [availability, namesAgent] of cases) {
      const [warning] = timezoneWarnings(availability);
      expect(warning).not.toMatch(/catalog_sync|reinvent-scout catalog|personal-time/);
      if (namesAgent) expect(warning).toContain("catalog-sync agent");
    }
  });

  it("tells an omitted-by-the-API timezone apart from the pre-support case, with no false promise of a fix", () => {
    const availability: TimezoneAvailability = { status: "unavailable", reason: "omittedByApi" };
    const [warning] = timezoneWarnings(availability);
    expect(warning).toMatch(/omitted it/i);
    expect(warning).not.toMatch(/very likely resolve/i);
  });
});
