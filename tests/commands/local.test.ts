import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { OUTPUT_BUDGET_BYTES, outputBytes } from "../../src/commands/output-budget.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const now = Date.parse("2026-12-02T18:00:00Z");
const session = (sessionId: string, time = "10:30", extra: Partial<Session> = {}): Session => ({ sessionId, abbreviation: `AB-${sessionId}`, title: `Title ${sessionId}`, venue: "MGM Grand", isReservable: true, seatAvailability: "available", sessionTime: { date: "2026-12-02", time, length: "30" }, ...extra });
const location = { venue: "MGM Grand", source: "user", confirmed: true };

describe("plan_schedule and nearby_sessions as commands", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const seed = (raw: Session[], eventId = "reinvent2026") => writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId, syncedAt: now, count: raw.length, totalCount: raw.length, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
  const call = (name: "plan_schedule" | "nearby_sessions", input: unknown) => callCommand(name, input, { storeRoot: home.path, now: () => 0 });
  const empty = { reserved: [], favorites: [], personalTime: [] };

  describe("plan_schedule", () => {
    it("plans against an inline GetSchedule schedule", async () => {
      seed([session("a")]);
      const result = await call("plan_schedule", { sessionIds: ["a"], schedule: empty });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text).selected[0].sessionId).toBe("a");
    });
    it("plans against a saved GetSchedule result", async () => {
      seed([session("a")]);
      const path = join(home.path, "schedule.json"); writeFileSync(path, JSON.stringify({ schedule: empty }));
      expect(JSON.parse((await call("plan_schedule", { sessionIds: ["a"], scheduleFile: path })).text).selected).toHaveLength(1);
    });
    it("a reserved session and a personal-time block both constrain the plan", async () => {
      seed([session("a"), session("b")]);
      const reserved = JSON.parse((await call("plan_schedule", { sessionIds: ["a"], schedule: { ...empty, reserved: ["b"] } })).text);
      expect(reserved.selected).toEqual([]);
      const personalTime = [{ personalTimeId: "p", title: "Busy", description: "", startDateTime: "2026-12-02T18:30:00", endDateTime: "2026-12-02T19:30:00" }];
      expect(JSON.parse((await call("plan_schedule", { sessionIds: ["a"], schedule: { ...empty, personalTime } })).text).selected).toEqual([]);
    });
    it("needs a schedule, and reports a bad one by name", async () => {
      seed([session("a")]);
      const missing = await call("plan_schedule", { sessionIds: ["a"] });
      expect(missing.isError).toBe(true); expect(missing.text).toMatch(/schedule/);
      const bad = await call("plan_schedule", { sessionIds: ["a"], schedule: { reserved: "nope", personalTime: [] } });
      expect(bad.isError).toBe(true);
    });
    it("an empty request needs nothing", async () => {
      expect(JSON.parse((await call("plan_schedule", { sessionIds: [] })).text).selected).toEqual([]);
    });
    it("rejects an unknown key and stays within the output budget", async () => {
      seed([session("a")]);
      expect((await call("plan_schedule", { sessionIds: ["a"], schedule: empty, surprise: 1 })).isError).toBe(true);
      const big = Array.from({ length: 50 }, (_, i) => session(`s${i}`, "10:30", { title: "界".repeat(3000), sessionTime: { date: "2026-12-02", time: "10:30", length: "30" } }));
      seed(big);
      const result = await call("plan_schedule", { sessionIds: big.map(s => s.sessionId), schedule: empty });
      expect(outputBytes(JSON.parse(result.text))).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    });
  });

  describe("nearby_sessions", () => {
    const base = { eventId: "reinvent2026", location, schedule: empty };
    it("call 1 lists the sessions to read; call 2 uses what was read", async () => {
      seed([session("a")]);
      const one = JSON.parse((await callCommand("nearby_sessions", base, { storeRoot: home.path, now: () => now })).text);
      expect(one.refreshIds).toEqual(["a"]);
      const two = JSON.parse((await callCommand("nearby_sessions", { ...base, liveSessions: [session("a")] }, { storeRoot: home.path, now: () => now })).text);
      expect(two.refreshIds).toEqual([]);
      expect(two.candidates[0]).toMatchObject({ sessionId: "a", availability: "available", availabilitySource: "live" });
    });
    it("takes the schedule from a saved file too", async () => {
      seed([session("a")]);
      const path = join(home.path, "s.json"); writeFileSync(path, JSON.stringify(empty));
      const noSchedule: Record<string, unknown> = { ...base };
      delete noSchedule.schedule;
      const result = JSON.parse((await callCommand("nearby_sessions", { ...noSchedule, scheduleFile: path }, { storeRoot: home.path, now: () => now })).text);
      expect(result.refreshIds).toEqual(["a"]);
    });
    it("refuses more than 20 live sessions, both schedule forms, and a missing schedule", async () => {
      seed([session("a")]);
      const opts = { storeRoot: home.path, now: () => now };
      expect((await callCommand("nearby_sessions", { ...base, liveSessions: Array.from({ length: 21 }, (_, i) => session(`x${i}`)) }, opts)).isError).toBe(true);
      expect((await callCommand("nearby_sessions", { ...base, scheduleFile: "/nope.json" }, opts)).isError).toBe(true);
      const noSchedule: Record<string, unknown> = { ...base };
      delete noSchedule.schedule;
      expect((await callCommand("nearby_sessions", noSchedule, opts)).isError).toBe(true);
    });
  });
});
