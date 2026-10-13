import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Schedule, Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { AuthRequiredError, NotRegisteredError, ThrottledError } from "../../src/core/errors.js";
import { planScheduleViaApi, recommendNearbyViaApi } from "../../src/legacy/api-adapters.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const now = Date.parse("2026-12-02T18:00:00Z");
const session = (sessionId = "a", time = "10:30"): Session => ({ sessionId, title: sessionId, venue: "MGM Grand", isReservable: true, seatAvailability: "available", sessionTime: { date: "2026-12-02", time, length: "30" } });
const location = { venue: "MGM Grand" as const, source: "user" as const, confirmed: true };

describe("legacy API adapters (removed with the legacy surfaces)", () => {
  let home: TempHome; let raw: Session[]; let schedule: Schedule; let reads: string[]; let scheduleReads: number;
  beforeEach(() => { home = createTempHome(); raw = [session()]; schedule = { reserved: [], favorites: [], personalTime: [] }; reads = []; scheduleReads = 0; });
  afterEach(() => home.cleanup());
  function seed(eventId = "event") {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId, syncedAt: now, count: raw.length, totalCount: raw.length, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
  }
  const client = (getSession: (id: string) => Promise<Session> = async id => raw.find(s => s.sessionId === id)!) => ({
    getSchedule: async () => { scheduleReads++; return schedule; },
    getSession: async (_event: string, id: string) => { reads.push(id); return getSession(id); },
  });

  describe("planScheduleViaApi", () => {
    it("checks the catalog event before reading the account schedule, then reads it once", async () => {
      seed();
      await expect(planScheduleViaApi(["a"], { storeRoot: home.path, apiClient: client(), eventId: "other", now: () => 0 })).rejects.toThrow(/event/);
      expect(scheduleReads).toBe(0);
      const plan = await planScheduleViaApi(["a"], { storeRoot: home.path, apiClient: client(), eventId: "event", now: () => 0 });
      expect(plan.selected[0]!.sessionId).toBe("a");
      expect(scheduleReads).toBe(1);
    });
    it("needs neither the catalog nor an account read for an empty request", async () => {
      const plan = await planScheduleViaApi([], { storeRoot: home.path, apiClient: client() });
      expect(plan.selected).toEqual([]); expect(scheduleReads).toBe(0);
    });
    it("plans against the account's personal time", async () => {
      seed();
      schedule = { ...schedule, personalTime: [{ personalTimeId: "p", title: "Busy", description: "", startDateTime: "2026-12-02T18:30:00", endDateTime: "2026-12-02T19:30:00" }] };
      const plan = await planScheduleViaApi(["a"], { storeRoot: home.path, apiClient: client(), eventId: "event", now: () => 0 });
      expect(plan.selected).toEqual([]); expect(plan.rejected[0]!.reason).toBe("conflict");
    });
  });

  describe("recommendNearbyViaApi", () => {
    const run = (extra = {}) => recommendNearbyViaApi({ eventId: "event", location, ...extra }, { storeRoot: home.path, apiClient: client(), now: () => now });
    it("checks the catalog before reading the account", async () => {
      seed();
      await expect(recommendNearbyViaApi({ eventId: "wrong", location }, { storeRoot: home.path, apiClient: client(), now: () => now })).rejects.toThrow(/event/);
      expect(scheduleReads).toBe(0); expect(reads).toEqual([]);
    });
    it("reads the schedule once, reads each refresh id serially, and returns the live result", async () => {
      seed();
      let active = 0;
      const result = await recommendNearbyViaApi({ eventId: "event", location }, { storeRoot: home.path, apiClient: client(async id => { active++; expect(active).toBe(1); await Promise.resolve(); active--; return raw.find(s => s.sessionId === id)!; }), now: () => now });
      expect(scheduleReads).toBe(1); expect(reads).toEqual(["a"]);
      expect(result.candidates[0]).toMatchObject({ sessionId: "a", availability: "available", availabilitySource: "live" });
      expect(result.coverage).toMatchObject({ liveUsed: 1 });
    });
    it("does not read sessions when venue confirmation is needed", async () => {
      seed();
      const result = await run({ location: { ...location, confirmed: false } });
      expect(result.needsVenueConfirmation).toBe(true); expect(reads).toEqual([]);
    });
    it("caps the reads at 20 and reports what was not refreshed", async () => {
      raw = Array.from({ length: 25 }, (_, i) => session(String(i).padStart(2, "0"))); seed();
      const result = await run({ limit: 20 });
      expect(reads).toHaveLength(20); expect(result.coverage).toMatchObject({ eligible: 25, liveUsed: 20, unrefreshed: 5 });
    });
    it("keeps going after an ordinary read failure, leaving that band unknown", async () => {
      raw = [session("a"), session("b")]; seed();
      const result = await recommendNearbyViaApi({ eventId: "event", location }, { storeRoot: home.path, apiClient: client(async id => { if (id === "a") throw new Error("offline"); return raw.find(s => s.sessionId === id)!; }), now: () => now });
      expect(reads).toEqual(["a", "b"]); expect(result.candidates.map(c => c.sessionId)).toEqual(["b"]);
    });
    it.each([new AuthRequiredError(), new NotRegisteredError(), new ThrottledError()])("stops reading after an account or quota error: $name", async error => {
      raw = [session("a"), session("b")]; seed();
      const result = await recommendNearbyViaApi({ eventId: "event", location }, { storeRoot: home.path, apiClient: client(async () => { throw error; }), now: () => now });
      expect(reads).toEqual(["a"]); expect(result.coverage.liveUsed).toBe(0);
    });
    it("ignores a response for a different session", async () => {
      seed();
      const result = await recommendNearbyViaApi({ eventId: "event", location }, { storeRoot: home.path, apiClient: client(async () => session("someone-else")), now: () => now });
      expect(result.candidates).toEqual([]); expect(result.coverage.liveUsed).toBe(0);
    });
  });
});
