import { describe, expect, it } from "vitest";
import { boundedReservationResult, boundedSchedulePlan, responseBytes } from "../../src/mcp/response-budget.js";
import { RESPONSE_BUDGET_BYTES, validateSessionIds, type ReserveSessionsResult } from "../../src/schedule/reservations.js";

describe("mandatory reservation ledgers", () => {
  it("preserves every maximal ASCII ID and state while trimming only optional descriptions/conflicts", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(126)}`);
    expect(validateSessionIds(ids)).toEqual(ids);
    const raw: ReserveSessionsResult = { successful: [], alreadyScheduled: [], uncertain: [], notAttempted: [], failed: ids.map(sessionId => ({ sessionId, code: "scheduleConflict", reason: "界".repeat(50000), conflictsWith: Array.from({ length: 20 }, (_, i) => ({ sessionId: `${i}${"界".repeat(10000)}`, title: "t".repeat(10000) })) })), verified: { reserved: [] }, mismatch: [] };
    const result = boundedReservationResult(raw);
    expect(responseBytes(result, true)).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(result.failed.map(value => value.sessionId)).toEqual(ids);
    expect(result.failed.every(value => value.code === "scheduleConflict")).toBe(true);
    expect(result.failed.every(value => value.omittedConflicts > 0)).toBe(true);
    expect(result.detailsTruncated).toBe(true);
    expect(raw.failed[0]!.reason!.length).toBe(50000);
  });
  it("bounds planning output by whole entries with honest counts", () => {
    const selected = Array.from({ length: 50 }, (_, i) => ({ sessionId: String(i), requestedId: String(i), title: "界".repeat(10000), code: "a", startsAt: "2026-12-02T18:00:00Z", endsAt: "2026-12-02T19:00:00Z" }));
    const result = boundedSchedulePlan({ selected, alreadyReserved: [], alreadyReservedAlternative: [], rejected: [], alternatives: [], blockedBy: [], conflictFree: true, limitations: "Time only" });
    expect(responseBytes(result)).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(result.selected.length + result.omitted.selected).toBe(50);
    expect(result.omitted.selected).toBeGreaterThan(0);
  });
});

it("bounds already-reserved alternatives by whole entries with honest counts", () => {
  const alreadyReservedAlternative = Array.from({ length: 50 }, (_, i) => ({ requested: `${i}${"界".repeat(10000)}`, reservedSessionId: "r" }));
  const result = boundedSchedulePlan({ selected: [], alreadyReserved: [], alreadyReservedAlternative, rejected: [], alternatives: [], blockedBy: [], conflictFree: true, limitations: "Time only" });
  expect(responseBytes(result)).toBeLessThan(RESPONSE_BUDGET_BYTES);
  expect(result.alreadyReservedAlternative.length + result.omitted.alreadyReservedAlternative).toBe(50);
  expect(result.omitted.alreadyReservedAlternative).toBeGreaterThan(0);
});

it("bounds mixed Unicode refusal codes and read-back IDs without dropping any state", () => {
  const ids = Array.from({ length: 50 }, (_, i) => `${i}${"界".repeat(67)}`);
  expect(validateSessionIds(ids)).toEqual(ids);
  const raw: ReserveSessionsResult = { successful: [], alreadyScheduled: [], uncertain: [], notAttempted: [], failed: ids.map(sessionId => ({ sessionId, code: "界".repeat(1000), reason: "界".repeat(1000) })), verified: { reserved: ids }, mismatch: [], verificationError: "界".repeat(10000), aborted: { reason: "界".repeat(10000), message: "界".repeat(10000) } };
  const result = boundedReservationResult(raw);
  expect(responseBytes(result, true)).toBeLessThan(RESPONSE_BUDGET_BYTES);
  expect(result.failed.map(value => value.sessionId)).toEqual(ids);
  expect(result.verified).toEqual({ reserved: ids });
  expect(result.detailsTruncated).toBe(true);
});
