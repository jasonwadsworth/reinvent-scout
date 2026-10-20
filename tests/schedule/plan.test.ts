import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildSchedulePlan, planSchedule, sessionInterval } from "../../src/schedule/plan.js";
import { createTempHome } from "../helpers/temp-home.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import type { Schedule } from "../../src/aws/types.js";

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
  it("reports a requested sitting whose talk is reserved in another sitting instead of dropping it", () => {
    const ctx = context([session("r", "10:00", "ARC325-R"), session("r1", "11:00", "ARC325-R1"), session("other", "13:00", "OTH100")]); ctx.schedule.reserved = ["r1"];
    const plan = buildSchedulePlan(["r", "other"], ctx);
    expect(plan.alreadyReservedAlternative).toEqual([{ requested: "r", reservedSessionId: "r1" }]);
    expect(plan.alreadyReserved).toEqual(["r1"]);
    expect(plan.selected.map(value => value.sessionId)).toEqual(["other"]);
    expect(plan.rejected).toEqual([]);
  });
  it("does not report an alternative when the requested sitting itself is the reserved one", () => {
    const ctx = context([session("r", "10:00", "ARC325-R"), session("r1", "11:00", "ARC325-R1")]); ctx.schedule.reserved = ["r1"];
    const plan = buildSchedulePlan(["r1"], ctx);
    expect(plan.alreadyReservedAlternative).toEqual([]);
    expect(plan.alreadyReserved).toEqual(["r1"]);
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
  it("orchestration is synchronous, requires a current event-matching catalog, and takes the schedule as data", () => {
    const home = createTempHome();
    try {
      const index = [session("a")];
      writeCatalog({ raw: [], index, meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt: 1, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
      expect(() => planSchedule(["a"], { storeRoot: home.path, schedule: empty(), eventId: "other", now: () => 0 })).toThrow(/event/);
      const plan = planSchedule(["a"], { storeRoot: home.path, schedule: empty(), eventId: "event", now: () => 0 });
      expect(plan).not.toBeInstanceOf(Promise);
      expect(plan.selected[0]!.sessionId).toBe("a");
    } finally { home.cleanup(); }
  });
  it("needs a schedule when there is anything to plan", () => {
    const home = createTempHome();
    try {
      writeCatalog({ raw: [], index: [session("a")], meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt: 1, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
      expect(() => planSchedule(["a"], { storeRoot: home.path, eventId: "event", now: () => 0 })).toThrow(/schedule/);
    } finally { home.cleanup(); }
  });
  it("a personal-time block from the schedule blocks an overlapping offering", () => {
    const home = createTempHome();
    try {
      writeCatalog({ raw: [], index: [session("a")], meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "event", syncedAt: 1, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
      const interval = sessionInterval(session("a"), "America/Los_Angeles")!;
      const personalTime = [{ personalTimeId: "p", title: "Busy", description: "", startDateTime: interval.startsAt.slice(0, 19), endDateTime: interval.endsAt.slice(0, 19) }];
      const plan = planSchedule(["a"], { storeRoot: home.path, schedule: { reserved: [], favorites: [], personalTime }, eventId: "event", now: () => 0 });
      expect(plan.selected).toEqual([]);
      expect(plan.rejected[0]!.reason).toBe("conflict");
    } finally { home.cleanup(); }
  });
});

it("empty orchestration input needs neither catalog nor schedule", () => {
  const home = createTempHome();
  try {
    const result = planSchedule([], { storeRoot: home.path });
    expect(result.selected).toEqual([]); expect(result.conflictFree).toBe(true);
  } finally { home.cleanup(); }
});
