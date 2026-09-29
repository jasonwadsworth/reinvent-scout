import { describe, expect, it } from "vitest";
import { VENUES } from "../../src/catalog/venue.js";
import { effectiveOnsitePreferences } from "../../src/onsite/config.js";
import { estimateTravel } from "../../src/onsite/travel.js";
const prefs = () => effectiveOnsitePreferences({ schemaVersion: 1, allowWalkUp: false, events: [] }, "event");
const departure = Date.parse("2026-12-02T20:00:00Z");
describe("conservative travel estimates", () => {
  it.each(VENUES)("provides positive walking assumptions to all venues from %s", from => {
    for (const to of VENUES) expect(estimateTravel(from, to, departure, "America/Los_Angeles", prefs())).toMatchObject({ mode: "walk", provenance: "default assumption", totalMinutes: expect.any(Number) });
    expect(estimateTravel(from, from, departure, "America/Los_Angeles", prefs()).totalMinutes).toBe(10);
  });
  it("uses the approved walking table and directed overrides", () => {
    const p = prefs(); p.routes = [{ from: "MGM Grand", to: "Venetian", mode: "walk", minutes: 23 }];
    expect(estimateTravel("MGM Grand", "Venetian", departure, "America/Los_Angeles", p)).toMatchObject({ totalMinutes: 23, provenance: "user override", checkInMinutes: 10 });
    expect(estimateTravel("Venetian", "MGM Grand", departure, "America/Los_Angeles", p).totalMinutes).toBe(55);
  });
  it("adds peak buffer according to event timezone and half-open windows", () => {
    const p = prefs(); p.peakWindows = [{ start: "08:00", end: "10:00" }];
    expect(estimateTravel("MGM Grand", "MGM Grand", Date.parse("2026-12-02T17:00Z"), "America/Los_Angeles", p).totalMinutes).toBe(15);
    expect(estimateTravel("MGM Grand", "MGM Grand", Date.parse("2026-12-02T18:00Z"), "America/Los_Angeles", p).totalMinutes).toBe(10);
  });
  it("requires enabled shuttle and configured operating window, includes wait", () => {
    const p = prefs(); p.routes = [{ from: "MGM Grand", to: "Venetian", mode: "shuttle", minutes: 12, waitMinutes: 8 }];
    expect(estimateTravel("MGM Grand", "Venetian", departure, "America/Los_Angeles", p).mode).toBe("walk");
    p.shuttleEnabled = true;
    expect(estimateTravel("MGM Grand", "Venetian", departure, "America/Los_Angeles", p).mode).toBe("walk");
    p.shuttleWindows = [{ start: "11:00", end: "13:00" }];
    expect(estimateTravel("MGM Grand", "Venetian", departure, "America/Los_Angeles", p)).toMatchObject({ mode: "shuttle", totalMinutes: 20, waitMinutes: 8 });
    expect(estimateTravel("MGM Grand", "Venetian", departure + 60 * 60_000, "America/Los_Angeles", p).mode).toBe("walk");
  });
  it("uses route operating windows and peak overrides before globals", () => {
    const p = prefs(); p.shuttleEnabled = true; p.shuttleWindows = [{ start: "00:00", end: "23:59" }];
    p.routes = [{ from: "MGM Grand", to: "Venetian", mode: "shuttle", minutes: 12, waitMinutes: 1, windows: [{ start: "13:00", end: "14:00" }], peakBufferMinutes: 0 }];
    expect(estimateTravel("MGM Grand", "Venetian", departure, "America/Los_Angeles", p).mode).toBe("walk");
    p.routes[0]!.windows = [{ start: "08:00", end: "10:00" }];
    expect(estimateTravel("MGM Grand", "Venetian", Date.parse("2026-12-02T17:00Z"), "America/Los_Angeles", p)).toMatchObject({ mode: "shuttle", totalMinutes: 13, peakMinutes: 0 });
  });
  it("supports windows wrapping midnight", () => {
    const p = prefs(); p.peakWindows = [{ start: "23:00", end: "01:00" }];
    expect(estimateTravel("MGM Grand", "MGM Grand", Date.parse("2026-12-03T08:30Z"), "America/Los_Angeles", p).peakMinutes).toBe(5);
  });
});
