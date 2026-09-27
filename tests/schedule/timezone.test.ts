import { describe, expect, it } from "vitest";
import { addMinutesToIso, zonedWallClockToUtcIso } from "../../src/schedule/timezone.js";

describe("zonedWallClockToUtcIso", () => {
  it("converts a Pacific Standard Time wall clock to its correct UTC instant", () => {
    // Dec 1 2026 is after DST ends (Nov 1 2026), so Pacific is UTC-8: 10:30 local -> 18:30 UTC.
    expect(zonedWallClockToUtcIso("2026-12-01", "10:30", "America/Los_Angeles")).toBe(
      "2026-12-01T18:30:00Z",
    );
  });

  it("converts an Eastern Standard Time wall clock to its correct UTC instant", () => {
    // Eastern is UTC-5 in December: 09:00 local -> 14:00 UTC. A second real zone, not just a
    // restatement of the Pacific case, so this can't pass by coincidentally hardcoding -8h.
    expect(zonedWallClockToUtcIso("2026-12-01", "09:00", "America/New_York")).toBe(
      "2026-12-01T14:00:00Z",
    );
  });

  it("converts correctly across a real DST transition, proving this isn't a fixed offset", () => {
    // US DST began 2026-03-08: before it, Pacific is UTC-8; after it, UTC-7. A fixed-offset
    // implementation gets exactly one of these two cases right, never both.
    expect(zonedWallClockToUtcIso("2026-03-07", "10:00", "America/Los_Angeles")).toBe(
      "2026-03-07T18:00:00Z",
    );
    expect(zonedWallClockToUtcIso("2026-03-09", "10:00", "America/Los_Angeles")).toBe(
      "2026-03-09T17:00:00Z",
    );
  });

  it("gets a wall clock within an hour of the transition right, where a single-pass offset guess does not", () => {
    // The transition instant is 2026-03-08T10:00:00Z (2am PST -> 3am PDT). "09:30" local, read
    // naively as if it were itself a UTC instant (2026-03-08T09:30Z), falls just BEFORE that
    // real transition instant, so a single-pass conversion reads the zone's offset there as the
    // old PST -8h and answers 2026-03-08T17:30:00Z -- one hour late. The true answer needs the
    // offset at the *corrected* instant (2026-03-08T16:30Z, already PDT), which is only found by
    // re-checking the offset after the first correction: 09:30 local on the 8th is unambiguously
    // PDT (well after the 2am-to-3am jump), so it must convert using -7h, not -8h.
    expect(zonedWallClockToUtcIso("2026-03-08", "09:30", "America/Los_Angeles")).toBe(
      "2026-03-08T16:30:00Z",
    );
  });

  it("handles a timezone east of UTC with a positive offset", () => {
    // Tokyo is UTC+9 year-round (no DST): local = utc + 9h, so 09:00 local -> 00:00 UTC the same
    // calendar day.
    expect(zonedWallClockToUtcIso("2026-12-01", "09:00", "Asia/Tokyo")).toBe(
      "2026-12-01T00:00:00Z",
    );
  });

  it("never leaks the host machine's timezone into the result", () => {
    // This assertion's own correctness does not depend on the process TZ at all -- the whole
    // point is that it must hold identically no matter what TZ the process happens to run under.
    // The real cross-TZ proof is the suite-level check (`TZ=Asia/Tokyo` vs `TZ=UTC`, run as two
    // separate `npm test` invocations, per the reviewer's instruction) -- this test just pins the
    // expected value so a regression here is caught locally too.
    expect(zonedWallClockToUtcIso("2026-12-01", "20:00", "America/Los_Angeles")).toBe(
      "2026-12-02T04:00:00Z",
    );
  });
});

describe("addMinutesToIso", () => {
  it("adds whole minutes to a UTC ISO instant, staying on the same day", () => {
    expect(addMinutesToIso("2026-12-01T18:30:00Z", 60)).toBe("2026-12-01T19:30:00Z");
  });

  it("carries across a day boundary", () => {
    expect(addMinutesToIso("2026-12-01T23:30:00Z", 90)).toBe("2026-12-02T01:00:00Z");
  });
});
