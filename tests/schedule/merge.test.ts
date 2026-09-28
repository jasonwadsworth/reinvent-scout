import { describe, expect, it } from "vitest";
import type { PersonalTime } from "../../src/api/types.js";
import type { TimezoneAvailability } from "../../src/catalog/store.js";
import { mergeAndSortScheduleEntries, timezoneWarnings } from "../../src/schedule/merge.js";
import type { ResolvedScheduleSession, ScheduleSession } from "../../src/schedule/schedule.js";

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

function personalTime(overrides: Partial<PersonalTime> & { personalTimeId: string }): PersonalTime {
  return {
    startDateTime: "2026-12-01T00:00:00",
    endDateTime: "2026-12-01T01:00:00",
    title: "Untitled",
    description: "",
    ...overrides,
  };
}

describe("mergeAndSortScheduleEntries", () => {
  it("sorts sessions and personal time together by their common startsAt, across kinds", () => {
    // A Pacific-evening session (16:30 local -> 00:30Z, i.e. "the next day" in raw UTC) must still
    // sort *after* a personal-time block at 00:20Z, since 00:20Z really is earlier than 00:30Z --
    // proving startsAt, the shared real UTC instant, drives the order, not any kind-specific raw
    // field (the session's own raw local date, "2026-11-30", strongly suggests it should sort
    // first if read naively as a plain string against the personal time's "2026-12-01").
    const session = resolvedSession({
      sessionId: "s1",
      startDate: "2026-11-30",
      startTime: "16:30",
      title: "Evening session",
    });
    const pt = personalTime({
      personalTimeId: "pt1",
      startDateTime: "2026-12-01T00:20:00",
      endDateTime: "2026-12-01T00:40:00",
      title: "Dinner",
    });

    const merged = mergeAndSortScheduleEntries(
      { reserved: [], favorites: [session], personalTime: [pt] },
      "America/Los_Angeles",
    );

    expect(merged.map((entry) => entry.tiebreaker)).toEqual(["pt1", "s1"]);
    expect(merged[0]!.startsAt).toBe("2026-12-01T00:20:00Z");
    expect(merged[1]!.startsAt).toBe("2026-12-01T00:30:00Z");
  });

  it("gives personal time a real startsAt/endsAt even when the event timezone is unknown", () => {
    const pt = personalTime({ personalTimeId: "pt1", startDateTime: "2026-12-01T00:20:00", endDateTime: "2026-12-01T00:40:00" });

    const merged = mergeAndSortScheduleEntries({ reserved: [], favorites: [], personalTime: [pt] }, null);

    expect(merged[0]!.startsAt).toBe("2026-12-01T00:20:00Z");
    expect(merged[0]!.endsAt).toBe("2026-12-01T00:40:00Z");
  });

  it("sorts sessions with an unknown startsAt (timezone unknown) last, ordered among themselves by raw local date/time", () => {
    const early = resolvedSession({ sessionId: "early", startDate: "2026-11-30", startTime: "09:00" });
    const late = resolvedSession({ sessionId: "late", startDate: "2026-11-30", startTime: "14:00" });
    const unresolved: ScheduleSession = { sessionId: "unknown", resolved: false };

    const merged = mergeAndSortScheduleEntries(
      { reserved: [], favorites: [late, early, unresolved], personalTime: [] },
      null, // no timezone -- startsAt is null for every session
    );

    expect(merged.every((entry) => entry.startsAt === null)).toBe(true);
    expect(merged.map((entry) => entry.tiebreaker)).toEqual(["early", "late", "unknown"]);
  });

  it("puts an unscheduled/unresolved session after every scheduled one, even with a known timezone", () => {
    const scheduled = resolvedSession({ sessionId: "scheduled", startDate: "2026-11-30", startTime: "09:00" });
    const unresolved: ScheduleSession = { sessionId: "unresolved", resolved: false };

    const merged = mergeAndSortScheduleEntries(
      { reserved: [], favorites: [unresolved, scheduled], personalTime: [] },
      "America/Los_Angeles",
    );

    expect(merged.map((entry) => entry.tiebreaker)).toEqual(["scheduled", "unresolved"]);
  });

  it("carries the underlying session or personal-time object through on the matching field, null on the other", () => {
    const session = resolvedSession({ sessionId: "s1" });
    const pt = personalTime({ personalTimeId: "pt1" });

    const merged = mergeAndSortScheduleEntries({ reserved: [session], favorites: [], personalTime: [pt] }, null);

    const sessionEntry = merged.find((e) => e.kind === "reserved")!;
    const personalEntry = merged.find((e) => e.kind === "personalTime")!;
    expect(sessionEntry.session).toBe(session);
    expect(sessionEntry.personalTime).toBeNull();
    expect(personalEntry.personalTime).toBe(pt);
    expect(personalEntry.session).toBeNull();
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

  it("tells an omitted-by-the-API timezone apart from the pre-support case, with no false promise of a fix", () => {
    const availability: TimezoneAvailability = { status: "unavailable", reason: "omittedByApi" };
    const [warning] = timezoneWarnings(availability);
    expect(warning).toMatch(/omitted it/i);
    expect(warning).not.toMatch(/very likely resolve/i);
  });
});
