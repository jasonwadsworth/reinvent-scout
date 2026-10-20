import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, Schedule } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { updateOnsiteConfig } from "../../src/onsite/config.js";
import { recommendNearbySessions, type NearbyInput } from "../../src/onsite/recommend.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
const now = Date.parse("2026-12-02T18:00:00Z");
const session = (sessionId = "a", time = "10:30", venue = "MGM Grand"): Session => ({ sessionId, title: sessionId, venue, isReservable: true, seatAvailability: "available", sessionTime: { date: "2026-12-02", time, length: "30" } });
const location = { venue: "MGM Grand" as const, source: "user" as const, confirmed: true };
describe("nearby recommendations", () => {
  let home: TempHome; let raw: Session[]; let schedule: Schedule;
  beforeEach(() => { home = createTempHome(); raw = [session()]; schedule = { reserved: [], favorites: [], personalTime: [] }; });
  afterEach(() => home.cleanup());
  function deps(syncedAt = now, clock: () => number = () => now) {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt, count: raw.length, totalCount: raw.length, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    return { storeRoot: home.path, now: clock };
  }
  const input = (extra: Partial<NearbyInput> = {}): NearbyInput => ({ eventId: "event", location, schedule, ...extra });
  /** Call 1: no live data. */
  const first = (extra: Partial<NearbyInput> = {}, d = deps()) => recommendNearbySessions(input(extra), d);
  /** The agent's part: GetSession for each refresh id, then call 2 with what it read. */
  const twoCalls = (extra: Partial<NearbyInput> = {}, d = deps(), fresh?: (id: string) => Session) => {
    const one = recommendNearbySessions(input(extra), d);
    const liveSessions = one.refreshIds.map(id => fresh ? fresh(id) : raw.find(s => s.sessionId === id)!);
    return { one, two: recommendNearbySessions(input({ ...extra, liveSessions }), d), liveSessions };
  };

  it.each(["user", "location", "schedule"] as const)("requires per-call confirmation for %s venue", source => {
    const result = first({ location: { ...location, source, confirmed: false } });
    expect(result.needsVenueConfirmation).toBe(true); expect(result.candidates).toEqual([]); expect(result.refreshIds).toEqual([]);
  });
  it("call 1 lists what to read, with cached bands that are only unknown; call 2 returns fresh availability with both travel legs and no seat guarantee", () => {
    raw.push(session("next", "11:30")); schedule.reserved = ["next"];
    const { one, two } = twoCalls();
    expect(one.refreshIds).toEqual(["a"]);
    expect(one.candidates).toEqual([]);
    expect(two.candidates[0]).toMatchObject({ sessionId: "a", availability: "available", availabilitySource: "live", outbound: { totalMinutes: 10 }, onward: { totalMinutes: 10 }, nextCommitmentId: "next" });
    expect(two.limitations).toMatch(/guarantee/); expect(two.refreshIds).toEqual([]);
  });
  it("excludes infeasible outbound trips and all-day sessions before any read is asked for", () => {
    raw = [session("far", "10:30", "Venetian"), { ...session("all"), isAllDaySession: true }, session("past", "09:59")];
    const result = first();
    expect(result.candidates).toEqual([]); expect(result.refreshIds).toEqual([]);
  });
  it("full reserved schedule and personal commitments constrain onward travel, favorites do not", () => {
    raw.push(session("next", "11:10", "Venetian")); schedule.favorites = ["a"]; schedule.reserved = ["next"];
    expect(twoCalls().two.candidates).toEqual([]);
    schedule = { ...schedule, reserved: [] }; expect(twoCalls().two.candidates.map(c => c.sessionId)).toEqual(["a"]);
    schedule = { ...schedule, personalTime: [{ personalTimeId: "p", title: "Lunch", description: "", startDateTime: "2026-12-02T19:10:00", endDateTime: "2026-12-02T20:00:00", location: "Venetian" }] };
    expect(twoCalls().two.candidates).toEqual([]);
  });
  it("a personal-time block really blocks (dropping personal time from the hard commitments would show here)", () => {
    schedule = { ...schedule, personalTime: [{ personalTimeId: "p", title: "Busy", description: "", startDateTime: "2026-12-02T18:30:00", endDateTime: "2026-12-02T19:00:00", location: "MGM Grand" }] };
    const result = twoCalls().two;
    expect(result.candidates).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
  });
  it("explicit skip releases ongoing reservation for this call only", () => {
    raw.push(session("busy", "09:50")); schedule.reserved = ["busy"];
    expect(twoCalls().two.candidates).toEqual([]);
    const result = twoCalls({ skipSessionIds: ["busy"] }).two;
    expect(result.candidates[0]!.sessionId).toBe("a"); expect(result.warnings.join(" ")).toMatch(/not cancel/); expect(schedule.reserved).toEqual(["busy"]);
  });
  it.each(["time", "venue", "all-day", "band"])("recomputes after live %s change", change => {
    const fresh = session();
    if (change === "time") fresh.sessionTime!.time = "10:05";
    if (change === "venue") fresh.venue = "Wynn/Encore";
    if (change === "all-day") fresh.isAllDaySession = true;
    if (change === "band") fresh.seatAvailability = "unavailable";
    const { one, two } = twoCalls({}, deps(), () => fresh);
    expect(two.candidates).toEqual([]); expect(one.refreshIds).toEqual(["a"]);
  });
  it("treats stale/missing bands as unknown unless walk-up enabled and honors explicit false", () => {
    const d = deps(now - 600_000);
    expect(first({}, d).candidates).toEqual([]);
    updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path });
    const result = first({}, d);
    expect(result.candidates[0]).toMatchObject({ availability: "unknown", availabilitySource: "cache", observedAt: now - 600_000 });
    updateOnsiteConfig("event", { sessionWalkUp: [{ sessionId: "a", allowWalkUp: false }] }, { storeRoot: home.path });
    expect(first({}, d).candidates).toEqual([]);
  });
  describe("freshness while the call runs", () => {
    // `now` jumps 7 minutes on every read after the entry read; the freshness window is 5. A band
    // observed at entry is fresh then, but stale by the time the whole run completes.
    const slowClock = () => { let clock = now; let calls = 0; return () => { calls++; if (calls > 1) clock += 7 * 60_000; return clock; }; };
    const slow = () => { raw = [session("a", "11:00"), session("b", "11:00")]; return deps(now, slowClock()); };
    it("stamps live bands at the moment the call starts, and downgrades one that went stale during the run", () => {
      const d = slow();
      const liveSessions = raw;
      const result = recommendNearbySessions(input({ withinMinutes: 90, liveSessions }), d);
      expect(result.candidates.every(c => c.observedAt === now)).toBe(true);
      expect(result.candidates.map(c => c.availability)).not.toContain("available");
      expect(result.rejected).toContainEqual({ reason: "admissionNotAllowed", count: 2 });
    });
    it("keeps a stale candidate as unknown when walk-up is allowed", () => {
      updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path });
      const d = slow();
      const result = recommendNearbySessions(input({ withinMinutes: 90, liveSessions: raw }), d);
      const a = result.candidates.find(c => c.sessionId === "a")!;
      expect(a).toMatchObject({ availability: "unknown", admission: "Admission unknown; confirm on site." });
      expect(a.ageMinutes).toBeGreaterThan(5);
    });
  });
  it("without live data a recent catalog band is still unknown, and personal IDs cannot hide a conflict", () => {
    expect(first().candidates).toEqual([]);
    schedule = { ...schedule, personalTime: [{ personalTimeId: "a", title: "Busy", description: "", startDateTime: "2026-12-02T18:30:00", endDateTime: "2026-12-02T19:00:00", location: "MGM Grand" }] };
    expect(twoCalls().two.candidates).toEqual([]);
  });
  it("uses fresh reservability instead of pre-opening cached flags", () => {
    raw[0]!.isReservable = false; delete raw[0]!.seatAvailability;
    expect(twoCalls({}, deps(), () => session()).two.candidates[0]!.availability).toBe("available");
  });
  it("reserved attendance survives unavailable admission and ranks first", () => {
    raw = [session("other"), { ...session("reserved"), seatAvailability: "unavailable" }]; schedule.reserved = ["reserved"];
    const result = twoCalls().two;
    expect(result.candidates.map(c => c.sessionId)).toEqual(["reserved"]); expect(result.candidates[0]!.reserved).toBe(true);
  });
  it("counts unknown and repeated live sessions as ignored, using each id once", () => {
    raw = [session("a"), session("b")];
    const d = deps();
    const result = recommendNearbySessions(input({ liveSessions: [raw[0]!, raw[0]!, session("not-a-candidate")] }), d);
    expect(result.coverage).toMatchObject({ liveProvided: 3, liveUsed: 1, liveIgnored: 2 });
    expect(result.refreshIds).toEqual(["b"]);
  });
  it("lists each offering once even with duplicate catalog rows", () => {
    raw.push(session());
    const { one, two } = twoCalls();
    expect(one.refreshIds).toEqual(["a"]); expect(two.candidates).toHaveLength(1);
  });
  it.each(["walkUp", "unknown", "malformed"])("requires walk-up permission for %s admission", band => {
    raw[0]!.seatAvailability = band as Session["seatAvailability"] & string;
    expect(twoCalls().two.candidates).toEqual([]);
    updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path });
    expect(twoCalls().two.candidates[0]!.availability).toBe(band === "walkUp" ? "walkUp" : "unknown");
  });
  it("accepts exact arrival deadline but rejects a minute less", () => {
    raw = [session("a", "10:20")];
    expect(twoCalls().two.candidates).toHaveLength(1);
    raw[0]!.sessionTime!.time = "10:19";
    expect(twoCalls().two.candidates).toHaveLength(0);
  });
  it("asks for at most 20 reads and reports coverage on both calls", () => {
    raw = Array.from({ length: 25 }, (_, i) => session(String(i).padStart(2, "0")));
    const { one, two } = twoCalls({ limit: 20 });
    expect(one.refreshIds).toHaveLength(20);
    expect(one.refreshIds).toEqual(raw.slice(0, 20).map(s => s.sessionId));
    expect(one.coverage).toMatchObject({ eligible: 25, liveProvided: 0, liveUsed: 0, unrefreshed: 25 });
    expect(two.coverage).toMatchObject({ eligible: 25, liveProvided: 20, liveUsed: 20, liveIgnored: 0, unrefreshed: 5 });
    expect(two.candidates).toHaveLength(20); expect(two.refreshIds).toEqual([]);
  });
  it("unknown hard timing or next venue prevents claiming a feasible trip", () => {
    schedule.reserved = ["missing"];
    const blocked = twoCalls().two;
    expect(blocked.candidates).toEqual([]); expect(blocked.rejected).toContainEqual({ reason: "unknownHardTiming", count: 1 }); expect(blocked.warnings.join(" ")).toContain("missing");
    raw.push(session("next", "11:30", "Alien Venue")); schedule.reserved = ["next"];
    expect(twoCalls().two.candidates).toEqual([]);
  });
  it("requires matching event", () => {
    expect(() => first({ eventId: "wrong" })).toThrow(/event/);
  });
  it("needs a schedule, exactly one of inline and file", () => {
    expect(() => recommendNearbySessions({ eventId: "event", location }, deps())).toThrow(/schedule/);
  });
  it("uses the completion clock for live freshness and recomputes departure after the work", () => {
    let clock = now; let calls = 0;
    const tick = (ms: number) => () => { calls++; if (calls > 1) clock += ms; return clock; };
    expect(recommendNearbySessions(input({ liveSessions: raw }), deps(now, tick(1))).candidates[0]!.availability).toBe("available");
    calls = 0; clock = now;
    expect(recommendNearbySessions(input({ liveSessions: raw }), deps(now, tick(15 * 60_000))).candidates).toEqual([]);
  });
  it("rechecks earlier recommendations after later work consumes their travel window", () => {
    raw = [session("a", "10:20"), session("b", "10:40")];
    let clock = now; let calls = 0;
    const d = deps(now, () => { calls++; if (calls === 3) clock += 60_000; return clock; });
    const result = recommendNearbySessions(input({ liveSessions: raw }), d);
    expect(result.candidates.map(c => c.sessionId)).toEqual(["b"]);
  });
});
