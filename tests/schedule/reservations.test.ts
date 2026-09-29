import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BulkResult, Schedule } from "../../src/api/types.js";
import { markRequestNotSent, AuthRequiredError, NotRegisteredError, NotFoundError, OperationUnavailableError, ServiceError, ThrottledError } from "../../src/core/errors.js";
import { OAuthError } from "../../src/auth/oauth.js";
import { cancelReservation, reserveSessions } from "../../src/schedule/reservations.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
const schedule = (reserved: string[] = []): Schedule => ({ reserved, favorites: [], personalTime: [] });
describe("reservation outcomes", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  function client(reserve: (ids: string[]) => Promise<BulkResult>, read = async () => schedule()) {
    return { reserveSessions: async (_event: string, list: string[]) => reserve(list), getSchedule: read };
  }
  it("deduplicates before chunking and reconciles state without calling existing reservations newly successful", async () => {
    const calls: string[][] = [];
    const result = await reserveSessions([...ids(11), "s0"], { storeRoot: home.path, apiClient: client(async list => { calls.push(list); return { successful: list.filter(id => id !== "s0"), failed: list.includes("s0") ? [{ sessionId: "s0", code: "alreadyScheduled" }] : [] }; }, async () => schedule(ids(11))) });
    expect(calls.map(call => call.length)).toEqual([10, 1]);
    expect(result.successful).toEqual(ids(11).slice(1)); expect(result.alreadyScheduled).toEqual(["s0"]);
    expect(result.verified).toEqual({ reserved: ids(11) }); expect(result.mismatch).toEqual([]);
  });
  it.each([[], [""], ["x".repeat(129)], ids(51), Array.from({ length: 50 }, (_, i) => `${i}${"界".repeat(126)}`)].map(input => ({ input })))("rejects invalid IDs or impossible response budget before network", async ({ input }) => {
    let calls = 0; let t = 0;
    await expect(reserveSessions(input, { storeRoot: home.path, now: () => t, sleep: async ms => { t += ms; }, apiClient: client(async list => { calls++; return { successful: list, failed: [] }; }) })).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("keeps mixed refusals including unresolved conflict IDs and unknown codes", async () => {
    const failed = [{ sessionId: "b", code: "sessionFull" }, { sessionId: "c", code: "scheduleConflict", conflictsWith: ["constructor"] }, { sessionId: "d", code: "newServerCode" }];
    const result = await reserveSessions(["a", "b", "c", "d"], { storeRoot: home.path, apiClient: client(async () => ({ successful: ["a"], failed }), async () => schedule()) });
    expect(result.failed).toEqual([failed[0], { ...failed[1], conflictsWith: [{ sessionId: "constructor", title: null }] }, failed[2]]);
    expect(result.mismatch).toEqual(["a"]);
  });
  it.each([new AuthRequiredError(), new NotRegisteredError(), new OperationUnavailableError("Reservations open October 8")])("throws a first definite session-wide refusal: $name", async error => {
    await expect(reserveSessions(["a"], { storeRoot: home.path, apiClient: client(async () => { throw error; }) })).rejects.toThrow(error);
  });
  it.each([new AuthRequiredError(), new NotRegisteredError(), new OperationUnavailableError("closed"), new ThrottledError(), new OAuthError("server_error", "down")])("retains earlier outcomes and stops following chunks on $name", async error => {
    let calls = 0;
    const result = await reserveSessions(ids(21), { storeRoot: home.path, apiClient: client(async list => { if (++calls === 1) return { successful: list, failed: [] }; throw error; }, async () => { throw new Error("read failed"); }) });
    expect(calls).toBe(2); expect(result.successful).toEqual(ids(10));
    expect(result.failed.map(f => f.sessionId)).toEqual(ids(20).slice(10));
    expect(result.notAttempted).toEqual(["s20"]); expect(result.aborted).toBeDefined();
    expect(result.verified).toBeNull(); expect(result.verificationError).toBe("read failed");
  });
  it("retains uncertain 503 through later auth and failed reconciliation without replay", async () => {
    let calls = 0;
    const result = await reserveSessions(ids(21), { storeRoot: home.path, apiClient: client(async () => { if (++calls === 1) throw new ServiceError("lost acknowledgement"); throw new AuthRequiredError(); }, async () => { throw new AuthRequiredError(); }) });
    expect(calls).toBe(2); expect(result.uncertain).toEqual(ids(10)); expect(result.successful).toEqual([]);
    expect(result.notAttempted).toEqual(["s20"]); expect(result.verified).toBeNull();
  });
  it("readback presence after ambiguous write is observed state only", async () => {
    const result = await reserveSessions(["constructor"], { storeRoot: home.path, apiClient: client(async () => { throw new ServiceError("lost"); }, async () => schedule(["constructor"])) });
    expect(result.successful).toEqual([]); expect(result.uncertain).toEqual(["constructor"]); expect(result.verified).toEqual({ reserved: ["constructor"] });
  });
  it("preserves prior refusals through auth and marks omitted response IDs uncertain", async () => {
    let calls = 0;
    const result = await reserveSessions(ids(11), { storeRoot: home.path, apiClient: client(async () => { if (++calls === 1) return { successful: [], failed: [{ sessionId: "s0", code: "sessionFull" }] }; throw new AuthRequiredError(); }) });
    expect(result.failed[0]).toEqual({ sessionId: "s0", code: "sessionFull" }); expect(result.uncertain).toEqual(ids(10).slice(1));
  });
  it.each(["204", "404", "503"])("cancel %s retains acknowledgement or uncertainty and verifies absence", async status => {
    let calls = 0;
    const result = await cancelReservation("a", { storeRoot: home.path, apiClient: { cancelReservation: async () => { calls++; if (status === "404") throw new NotFoundError("absent"); if (status === "503") throw new ServiceError("lost"); }, getSchedule: async () => schedule() } });
    expect(calls).toBe(1); expect(result.outcome).toBe(status === "204" ? "cancelled" : status === "404" ? "alreadyAbsent" : "uncertain"); expect(result.verifiedAbsent).toBe(true);
  });
  it("cancel204 plus failed readback remains acknowledged", async () => {
    const result = await cancelReservation("a", { storeRoot: home.path, apiClient: { cancelReservation: async () => {}, getSchedule: async () => { throw new AuthRequiredError(); } } });
    expect(result).toMatchObject({ outcome: "cancelled", verifiedAbsent: null }); expect(result.verificationError).toContain("Not signed in");
  });
});

it("cancellation charges request units across calls", async () => {
  const home = createTempHome(); let t = 0; const waits: number[] = [];
  try {
    const deps = { storeRoot: home.path, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, apiClient: { cancelReservation: async () => {}, getSchedule: async () => schedule() } };
    for (let i = 0; i < 31; i++) await cancelReservation(String(i), deps);
    expect(waits).toEqual([61000]);
  } finally { home.cleanup(); }
});
it("contradictory acknowledgements cannot hide a requested ID or add unsolicited successes", async () => {
  const home = createTempHome();
  try {
    const result = await reserveSessions(["a", "b", "c"], { storeRoot: home.path, apiClient: { reserveSessions: async () => ({ successful: ["a", "a", "b", "unsolicited"], failed: [{ sessionId: "b", code: "sessionFull" }] }), getSchedule: async () => schedule() } });
    expect(result.uncertain).toEqual(["a", "b", "c"]); expect(result.successful).toEqual([]); expect(result.failed).toEqual([]);
  } finally { home.cleanup(); }
});

it("resolves conflict titles from the local index", async () => {
  const home = createTempHome();
  try {
    const { writeCatalog, CURRENT_SCHEMA_VERSION } = await import("../../src/catalog/store.js");
    const { buildIndexRecord } = await import("../../src/catalog/index-record.js");
    const raw = [{ sessionId: "blocked", title: "Reserved talk" }];
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, count: 1, totalCount: 1, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const result = await reserveSessions(["a"], { storeRoot: home.path, apiClient: { reserveSessions: async () => ({ successful: [], failed: [{ sessionId: "a", code: "scheduleConflict", conflictsWith: ["blocked"] }] }), getSchedule: async () => schedule(["blocked"]) } });
    expect(result.failed[0]!.conflictsWith).toEqual([{ sessionId: "blocked", title: "Reserved talk" }]);
  } finally { home.cleanup(); }
});

describe("reservation review fixes", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const client = (reserve: (list: string[]) => Promise<BulkResult>) => ({ reserveSessions: async (_event: string, list: string[]) => reserve(list), getSchedule: async () => schedule() });
  it("trims IDs before validation and sends the trimmed value, deduplicating after the trim", async () => {
    const sent: string[][] = [];
    await reserveSessions([" a ", "a", "\tb\n"], { storeRoot: home.path, apiClient: client(async list => { sent.push(list); return { successful: list, failed: [] }; }) });
    expect(sent).toEqual([["a", "b"]]);
    await expect(reserveSessions(["   "], { storeRoot: home.path, apiClient: client(async () => ({ successful: [], failed: [] })) })).rejects.toThrow();
  });
  it("reports a chunk whose token could not be obtained as not attempted, not failed", async () => {
    let calls = 0;
    const result = await reserveSessions(ids(21), { storeRoot: home.path, apiClient: client(async list => {
      if (++calls === 1) return { successful: list, failed: [] };
      throw markRequestNotSent(new OAuthError("server_error", "token endpoint down"));
    }) });
    expect(calls).toBe(2);
    expect(result.successful).toEqual(ids(10));
    expect(result.failed).toEqual([]);
    expect(result.uncertain).toEqual([]);
    expect(result.notAttempted).toEqual(ids(21).slice(10));
    expect(result.aborted).toBeDefined();
  });
  it("still reports a server-side rejection of that chunk as failed", async () => {
    let calls = 0;
    const result = await reserveSessions(ids(21), { storeRoot: home.path, apiClient: client(async list => {
      if (++calls === 1) return { successful: list, failed: [] };
      throw new OAuthError("server_error", "rejected");
    }) });
    expect(result.failed.map(f => f.sessionId)).toEqual(ids(21).slice(10, 20));
    expect(result.notAttempted).toEqual(["s20"]);
  });
});
