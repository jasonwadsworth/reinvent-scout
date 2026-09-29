import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildSchedulePlan, planSchedule } from "../../src/schedule/plan.js";
import { createTempHome } from "../helpers/temp-home.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import type { Schedule } from "../../src/api/types.js";

const session = (sessionId: string, startTime = "10:00", abbreviation = sessionId, date = "2026-12-02", length = "60") => buildIndexRecord({ sessionId, title: sessionId, abbreviation, sessionTime: { date, time: startTime, length } });
const empty = (): Schedule => ({ reserved: [], favorites: [], personalTime: [] });
const context = (index = [session("a"), session("b", "10:30"), session("c", "11:00")], schedule = empty()) => ({ index, schedule, eventTimezone: "America/Los_Angeles", now: () => Date.parse("2026-12-02T15:00:00Z") });

describe("conflict-free plan", () => {
  it("greedily honors priority, half-open adjacency and favorites do not block", () => {
    const ctx = context(); ctx.schedule.favorites = ["b"];
    const plan = buildSchedulePlan(["a", "b", "c", "a"], ctx);
    expect(plan.selected.map(value => value.sessionId)).toEqual(["a", "c"]);
    expect(plan.rejected).toContainEqual(expect.objectContaining({ sessionId: "b", reason: "conflict", conflictsWith: ["a"] }));
    expect(plan.conflictFree).toBe(true);
    expect(plan.selected[0]!.startsAt).toBe("2026-12-02T18:00:00Z");
  });
  it("tries the earliest feasible repeat, reports considered alternatives, and selects only one talk", () => {
    const ctx = context([session("r", "10:00", "ARC325-R"), session("r1", "11:00", "ARC325-R1"), session("busy")]);
    ctx.schedule.reserved = ["busy"];
    const plan = buildSchedulePlan(["r", "r1"], ctx);
    expect(plan.selected.map(value => value.sessionId)).toEqual(["r1"]);
    expect(plan.alternatives[0]!.sessionIds).toEqual(["r", "r1"]);
    expect(plan.rejected).toContainEqual(expect.objectContaining({ sessionId: "r1", reason: "duplicateTalk" }));
  });
  it("does not select a second sitting of an already reserved talk", () => {
    const ctx = context([session("r", "10:00", "ARC325-R"), session("r1", "11:00", "ARC325-R1")]); ctx.schedule.reserved = ["r1"];
    const plan = buildSchedulePlan(["r"], ctx);
    expect(plan.selected).toEqual([]); expect(plan.alreadyReserved).toEqual(["r1"]);
  });
  it("uses real event instants for cross-midnight personal commitments", () => {
    const ctx = context([session("night", "23:30", "N100", "2026-12-02"), session("later", "00:30", "N200", "2026-12-03")]);
    ctx.schedule.personalTime = [{ personalTimeId: "personal", title: "Dinner", description: "", startDateTime: "2026-12-03T07:45:00", endDateTime: "2026-12-03T08:30:00" }];
    const plan = buildSchedulePlan(["night", "later"], ctx);
    expect(plan.selected.map(value => value.sessionId)).toEqual(["later"]);
    expect(plan.rejected[0]!.conflictsWith).toEqual(["personal"]);
  });
  it.each(["2026-03-08", "2026-11-01"])("uses DST-aware offsets on %s", date => {
    const ctx = context([session("a", "10:00", "a", date)]); ctx.now = () => 0;
    const plan = buildSchedulePlan(["a"], ctx);
    expect(plan.selected[0]!.startsAt).toBe(date === "2026-03-08" ? `${date}T17:00:00Z` : `${date}T18:00:00Z`);
  });
  it.each(["0", "-1", "NaN", "Infinity"])("rejects invalid duration %s", length => {
    expect(buildSchedulePlan(["a"], context([session("a", "10:00", "a", "2026-12-02", length)])).selected).toEqual([]);
  });
  it.each([ ["2026-02-30", "10:00"], ["2026-12-02", "25:00"], ["2026-03-08", "02:30"] ])("rejects nonexistent local time %s %s", (date, time) => {
    const ctx = context([session("a", time, "a", date)]); ctx.now = () => 0;
    expect(buildSchedulePlan(["a"], ctx).rejected[0]!.reason).toBe("invalidTime");
  });
  it("unknown hard commitment or malformed personal interval blocks any conflict-free claim", () => {
    for (const schedule of [{ ...empty(), reserved: ["unknown"] }, { ...empty(), personalTime: [{ personalTimeId: "bad", title: "Bad", description: "", startDateTime: "2026-02-30T10:00:00", endDateTime: "2026-02-30T11:00:00" }] }, { ...empty(), personalTime: [{ personalTimeId: "backwards", title: "Bad", description: "", startDateTime: "2026-12-02T19:00:00", endDateTime: "2026-12-02T18:00:00" }] }]) {
      const result = buildSchedulePlan(["a"], context(undefined, schedule));
      expect(result.conflictFree).toBe(false); expect(result.selected).toEqual([]); expect(result.blockedBy).toHaveLength(1);
    }
  });
  it("missing timezone blocks and started sessions are rejected", () => {
    expect(buildSchedulePlan(["a"], { ...context(), eventTimezone: null }).conflictFree).toBe(false);
    expect(buildSchedulePlan(["a"], { ...context(), now: () => Date.parse("2026-12-02T18:00:00Z") }).rejected[0]!.reason).toBe("started");
  });
  it("handles missing/prototype IDs and empty input", () => {
    const result = buildSchedulePlan(["constructor"], context([session("constructor")]));
    expect(result.selected[0]!.sessionId).toBe("constructor");
    expect(buildSchedulePlan(["missing"], context()).rejected[0]!.reason).toBe("notInCatalog");
    expect(buildSchedulePlan([], context()).selected).toEqual([]);
  });
  it("orchestration requires a current event-matching catalog before schedule read, and never writes", async () => {
    const home = createTempHome(); let reads = 0;
    try {
      const index = [session("a")];
      writeCatalog({ raw: [], index, meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt: 1, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
      const apiClient = { getSchedule: async () => { reads++; return empty(); }, reserveSessions: async () => { throw new Error("planner wrote"); } };
      await expect(planSchedule(["a"], { storeRoot: home.path, apiClient, eventId: "other", now: () => 0 })).rejects.toThrow(/event/);
      expect(reads).toBe(0);
      expect((await planSchedule(["a"], { storeRoot: home.path, apiClient, eventId: "event", now: () => 0 })).selected[0]!.sessionId).toBe("a");
      expect(reads).toBe(1);
    } finally { home.cleanup(); }
  });
});

it("empty orchestration input needs neither catalog nor account read", async () => {
  const home = createTempHome(); let reads = 0;
  try {
    const result = await planSchedule([], { storeRoot: home.path, apiClient: { getSchedule: async () => { reads++; throw new Error("unexpected account read"); } } });
    expect(result.selected).toEqual([]); expect(result.conflictFree).toBe(true); expect(reads).toBe(0);
  } finally { home.cleanup(); }
});
