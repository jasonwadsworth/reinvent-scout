import { expect, it } from "vitest";
import { boundedNearbyResult, boundedOnsitePreferences, responseBytes } from "../../src/mcp/response-budget.js";
import { effectiveOnsitePreferences } from "../../src/onsite/config.js";
import type { NearbyResult } from "../../src/onsite/recommend.js";
import { estimateTravel } from "../../src/onsite/travel.js";
it("drops whole oversized nearby candidates and reports omissions", () => {
  const prefs = effectiveOnsitePreferences({ schemaVersion: 1, allowWalkUp: false, events: [] }, "event");
  const raw: NearbyResult = { needsVenueConfirmation: false, rejected: [], warnings: [], limitations: "No guarantee", coverage: { examined: 20, eligible: 20, refreshAttempts: 20, refreshed: 20, unrefreshed: 0, omitted: 0, refreshStopped: false }, candidates: Array.from({ length: 20 }, (_, i) => ({ sessionId: String(i), title: "界".repeat(5000), venue: "MGM Grand", startsAt: "x", endsAt: "y", availability: "unknown", availabilitySource: "cache", observedAt: 0, ageMinutes: 0, minutesToStart: 30, reserved: false, admission: "unknown", outbound: estimateTravel("MGM Grand", "MGM Grand", 0, "UTC", prefs) })) };
  const result = boundedNearbyResult(raw);
  expect(responseBytes(result)).toBeLessThan(30 * 1024); expect(result.coverage.omitted + result.candidates.length).toBe(20);
  expect(result.candidates[0]?.title).toBe(raw.candidates[0]!.title);
});
it("bounds event preference replies with counted whole override omissions", () => {
  const prefs = effectiveOnsitePreferences({ schemaVersion: 1, allowWalkUp: false, events: [] }, "event");
  prefs.sessionWalkUp = Array.from({ length: 500 }, (_, i) => ({ sessionId: `${i}${"界".repeat(100)}`, allowWalkUp: false }));
  const result = boundedOnsitePreferences(prefs);
  expect(responseBytes(result)).toBeLessThan(30 * 1024); expect(result.omitted.sessionWalkUp + result.sessionWalkUp.length).toBe(500);
});
