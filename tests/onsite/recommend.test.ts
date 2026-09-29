import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, Schedule } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { updateOnsiteConfig } from "../../src/onsite/config.js";
import { recommendNearbySessions } from "../../src/onsite/recommend.js";
import { AuthRequiredError, NotRegisteredError, ThrottledError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
const now = Date.parse("2026-12-02T18:00:00Z");
const session = (sessionId = "a", time = "10:30", venue = "MGM Grand"): Session => ({ sessionId, title: sessionId, venue, isReservable: true, seatAvailability: "available", sessionTime: { date: "2026-12-02", time, length: "30" } });
const location = { venue: "MGM Grand" as const, source: "user" as const, confirmed: true };
describe("nearby recommendations", () => {
  let home: TempHome; let raw: Session[]; let schedule: Schedule; let reads: string[];
  beforeEach(() => { home = createTempHome(); raw = [session()]; schedule = { reserved: [], favorites: [], personalTime: [] }; reads = []; });
  afterEach(() => home.cleanup());
  function deps(fresh?: (id: string) => Promise<Session>, syncedAt = now) {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt, count: raw.length, totalCount: raw.length, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    return { storeRoot: home.path, now: () => now, apiClient: { getSchedule: async () => schedule, getSession: async (_event: string, id: string) => { reads.push(id); return fresh ? fresh(id) : raw.find(s => s.sessionId === id)!; } } };
  }
  it.each(["user", "location", "schedule"] as const)("requires per-call confirmation for %s venue", async source => {
    const result = await recommendNearbySessions({ eventId: "event", location: { ...location, source, confirmed: false } }, deps());
    expect(result.needsVenueConfirmation).toBe(true); expect(result.candidates).toEqual([]); expect(reads).toEqual([]);
  });
  it("returns fresh availability with both travel legs and no seat guarantee", async () => {
    raw.push(session("next", "11:30")); schedule.reserved = ["next"];
    const result = await recommendNearbySessions({ eventId: "event", location }, deps());
    expect(result.candidates[0]).toMatchObject({ sessionId: "a", availability: "available", availabilitySource: "live", outbound: { totalMinutes: 10 }, onward: { totalMinutes: 10 }, nextCommitmentId: "next" });
    expect(result.limitations).toMatch(/guarantee/); expect(reads).toEqual(["a"]);
  });
  it("excludes infeasible outbound trips and all-day sessions before refresh", async () => {
    raw = [session("far", "10:30", "Venetian"), { ...session("all"), isAllDaySession: true }, session("past", "09:59")];
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toEqual([]); expect(reads).toEqual([]);
  });
  it("full reserved schedule and personal commitments constrain onward travel, favorites do not", async () => {
    raw.push(session("next", "11:10", "Venetian")); schedule.favorites = ["a"]; schedule.reserved = ["next"];
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toEqual([]);
    schedule.reserved = []; expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates.map(c => c.sessionId)).toEqual(["a"]);
    schedule.personalTime = [{ personalTimeId: "p", title: "Lunch", description: "", startDateTime: "2026-12-02T19:10:00", endDateTime: "2026-12-02T20:00:00", location: "Venetian" }];
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toEqual([]);
  });
  it("explicit skip releases ongoing reservation for this call only", async () => {
    raw.push(session("busy", "09:50")); schedule.reserved = ["busy"];
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toEqual([]);
    const result = await recommendNearbySessions({ eventId: "event", location, skipSessionIds: ["busy"] }, deps());
    expect(result.candidates[0]!.sessionId).toBe("a"); expect(result.warnings.join(" ")).toMatch(/not cancel/); expect(schedule.reserved).toEqual(["busy"]);
  });
  it.each(["time", "venue", "all-day", "band"])("recomputes after live %s change", async change => {
    const fresh = session();
    if (change === "time") fresh.sessionTime!.time = "10:05";
    if (change === "venue") fresh.venue = "Wynn/Encore";
    if (change === "all-day") fresh.isAllDaySession = true;
    if (change === "band") fresh.seatAvailability = "unavailable";
    expect((await recommendNearbySessions({ eventId: "event", location }, deps(async () => fresh))).candidates).toEqual([]); expect(reads).toEqual(["a"]);
  });
  it("treats stale/missing bands as unknown unless walk-up enabled and honors explicit false", async () => {
    const d = deps(async () => { throw new Error("offline"); }, now - 600_000);
    expect((await recommendNearbySessions({ eventId: "event", location }, d)).candidates).toEqual([]);
    updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path });
    const result = await recommendNearbySessions({ eventId: "event", location }, d);
    expect(result.candidates[0]).toMatchObject({ availability: "unknown", availabilitySource: "cache", observedAt: now - 600_000 });
    updateOnsiteConfig("event", { sessionWalkUp: [{ sessionId: "a", allowWalkUp: false }] }, { storeRoot: home.path });
    expect((await recommendNearbySessions({ eventId: "event", location }, d)).candidates).toEqual([]);
  });
  it("failed recent refresh remains unknown and personal IDs cannot hide a conflict", async () => {
    const d = deps(async () => { throw new Error("offline"); });
    expect((await recommendNearbySessions({ eventId: "event", location }, d)).candidates).toEqual([]);
    schedule.personalTime = [{ personalTimeId: "a", title: "Busy", description: "", startDateTime: "2026-12-02T18:30:00", endDateTime: "2026-12-02T19:00:00", location: "MGM Grand" }];
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toEqual([]);
  });
  it("uses fresh reservability instead of pre-opening cached flags", async () => {
    raw[0]!.isReservable = false; delete raw[0]!.seatAvailability;
    expect((await recommendNearbySessions({ eventId: "event", location }, deps(async () => session()))).candidates[0]!.availability).toBe("available");
  });
  it("reserved attendance survives unavailable admission and ranks first", async () => {
    raw = [session("other"), { ...session("reserved"), seatAvailability: "unavailable" }]; schedule.reserved = ["reserved"];
    const result = await recommendNearbySessions({ eventId: "event", location }, deps());
    expect(result.candidates.map(c => c.sessionId)).toEqual(["reserved"]); expect(result.candidates[0]!.reserved).toBe(true);
  });
  it.each([new AuthRequiredError(), new NotRegisteredError(), new ThrottledError()])("stops refresh reads after account/quota error $name", async error => {
    raw = [session("a"), session("b")];
    const result = await recommendNearbySessions({ eventId: "event", location }, deps(async () => { throw error; }));
    expect(reads).toEqual(["a"]); expect(result.coverage.refreshStopped).toBe(true);
  });
  it("reads each offering only once even with duplicate catalog rows", async () => {
    raw.push(session());
    const result = await recommendNearbySessions({ eventId: "event", location }, deps());
    expect(reads).toEqual(["a"]); expect(result.candidates).toHaveLength(1);
  });
  it.each(["walkUp", "unknown", "malformed"])("requires walk-up permission for %s admission", async band => {
    raw[0]!.seatAvailability = band as Session["seatAvailability"] & string;
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toEqual([]);
    updateOnsiteConfig("event", { allowWalkUp: true }, { storeRoot: home.path });
    const result = await recommendNearbySessions({ eventId: "event", location }, deps());
    expect(result.candidates[0]!.availability).toBe(band === "walkUp" ? "walkUp" : "unknown");
  });
  it("accepts exact arrival deadline but rejects a minute less", async () => {
    raw = [session("a", "10:20")];
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toHaveLength(1);
    raw[0]!.sessionTime!.time = "10:19";
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toHaveLength(0);
  });
  it("caps serial refresh at20 and reports coverage", async () => {
    raw = Array.from({ length: 25 }, (_, i) => session(String(i).padStart(2, "0"))); let active = 0;
    const result = await recommendNearbySessions({ eventId: "event", location, limit: 20 }, deps(async id => { active++; expect(active).toBe(1); await Promise.resolve(); active--; return raw.find(s => s.sessionId === id)!; }));
    expect(reads).toHaveLength(20); expect(result.coverage).toMatchObject({ eligible: 25, refreshAttempts: 20, unrefreshed: 5 }); expect(result.candidates).toHaveLength(20);
  });
  it("unknown hard timing or next venue prevents claiming a feasible trip", async () => {
    schedule.reserved = ["missing"];
    const blocked = await recommendNearbySessions({ eventId: "event", location }, deps());
    expect(blocked.candidates).toEqual([]); expect(blocked.rejected).toContainEqual({ reason: "unknownHardTiming", count: 1 }); expect(blocked.warnings.join(" ")).toContain("missing");
    raw.push(session("next", "11:30", "Alien Venue")); schedule.reserved = ["next"];
    expect((await recommendNearbySessions({ eventId: "event", location }, deps())).candidates).toEqual([]);
  });
  it("requires matching event before API reads", async () => {
    await expect(recommendNearbySessions({ eventId: "wrong", location }, deps())).rejects.toThrow(/event/); expect(reads).toEqual([]);
  });
});

it("uses the completion clock for live freshness and recomputes departure after refresh", async () => {
  const home = createTempHome(); let clock = now;
  const raw = [session()];
  try {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt: now, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    const deps = { storeRoot: home.path, now: () => clock, apiClient: { getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }), getSession: async () => { clock += 1; return raw[0]!; } } };
    expect((await recommendNearbySessions({ eventId: "event", location }, deps)).candidates[0]!.availability).toBe("available");
    deps.apiClient.getSession = async () => { clock += 15 * 60_000; return raw[0]!; };
    expect((await recommendNearbySessions({ eventId: "event", location }, deps)).candidates).toEqual([]);
  } finally { home.cleanup(); }
});


it("rechecks earlier recommendations after later refreshes consume their travel window", async () => {
  const home = createTempHome(); let clock = now;
  const raw = [session("a", "10:20"), session("b", "10:40")];
  try {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt: now, count: 2, totalCount: 2, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    const result = await recommendNearbySessions({ eventId: "event", location }, { storeRoot: home.path, now: () => clock, apiClient: { getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }), getSession: async (_e, id) => { if (id === "b") clock += 60_000; return raw.find(s => s.sessionId === id)!; } } });
    expect(result.candidates.map(c => c.sessionId)).toEqual(["b"]);
  } finally { home.cleanup(); }
});
