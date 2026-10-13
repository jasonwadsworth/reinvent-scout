import { describe, expect, it } from "vitest";
import { boundedSchedulePlan, OUTPUT_BUDGET_BYTES, outputBytes } from "../../src/commands/output-budget.js";

describe("schedule plan output budget", () => {
  it("bounds planning output by whole entries with honest counts", () => {
    const selected = Array.from({ length: 50 }, (_, i) => ({ sessionId: String(i), requestedId: String(i), title: "界".repeat(10000), code: "a", startsAt: "2026-12-02T18:00:00Z", endsAt: "2026-12-02T19:00:00Z" }));
    const result = boundedSchedulePlan({ selected, alreadyReserved: [], alreadyReservedAlternative: [], rejected: [], alternatives: [], blockedBy: [], conflictFree: true, limitations: "Time only" });
    expect(outputBytes(result)).toBeLessThan(OUTPUT_BUDGET_BYTES);
    expect(result.selected.length + result.omitted.selected).toBe(50);
    expect(result.omitted.selected).toBeGreaterThan(0);
  });
});

it("bounds already-reserved alternatives by whole entries with honest counts", () => {
  const alreadyReservedAlternative = Array.from({ length: 50 }, (_, i) => ({ requested: `${i}${"界".repeat(10000)}`, reservedSessionId: "r" }));
  const result = boundedSchedulePlan({ selected: [], alreadyReserved: [], alreadyReservedAlternative, rejected: [], alternatives: [], blockedBy: [], conflictFree: true, limitations: "Time only" });
  expect(outputBytes(result)).toBeLessThan(OUTPUT_BUDGET_BYTES);
  expect(result.alreadyReservedAlternative.length + result.omitted.alreadyReservedAlternative).toBe(50);
  expect(result.omitted.alreadyReservedAlternative).toBeGreaterThan(0);
});

