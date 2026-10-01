import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import type { FocusResult } from "../../src/match/focus.js";
import type { MatchCandidate, MatchResult } from "../../src/match/match.js";
import { buildFocusResponse, buildMatchResponse } from "../../src/match/response.js";

const offering = (code: string, withEnd: boolean) => ({
  sessionId: `${code}-id`, abbreviation: code, startDate: "2026-12-02", startTime: "10:00", ...(withEnd ? { endTime: "11:00" } : {}), venue: "MGM Grand" as const, room: "Level 3 | Room",
});
const candidate = (code: string, withEnd: boolean): MatchCandidate => ({
  code,
  record: buildIndexRecord({ sessionId: code, abbreviation: code, title: `Title ${code}`, type: "Chalk talk", level: "200 - Intermediate" }),
  score: 1, offerings: [offering(code, withEnd), offering(`${code}R`, withEnd)], why: { summary: "Matches.", yourCode: [] },
  reasons: [{ kind: "service", detail: "x".repeat(150), weight: 1, evidence: "x" }, { kind: "explainsConcept", detail: "kept", weight: 1, evidence: "y" }],
});
const result = (count: number, withEnd: boolean): MatchResult => ({ candidates: Array.from({ length: count }, (_, i) => candidate(`C${String(i).padStart(2, "0")}`, withEnd)), skippedRules: [] });
const fitsUnder = (bytes: number) => (value: unknown): boolean => JSON.stringify(value).length <= bytes;
const size = (value: unknown): number => JSON.stringify(value).length;
const hasEnds = (response: { candidates: Array<Record<string, unknown>> }): boolean => JSON.stringify(response.candidates).includes("endTime");

describe("the offering end times and the response budget", () => {
  it("keeps them when everything fits, and says nothing about them", () => {
    const response = buildMatchResponse(result(5, true), 5);
    expect(hasEnds(response)).toBe(true);
  });

  it("drops them, with the ranking reasons intact, before it drops the ranking reasons", () => {
    const full = size(buildMatchResponse(result(8, true), 8));
    const bare = size(buildMatchResponse(result(8, false), 8));
    expect(bare).toBeLessThan(full);
    const response = buildMatchResponse(result(8, true), 8, fitsUnder(bare));
    expect(response.returned).toBe(8);
    expect(hasEnds(response)).toBe(false);
    expect(response).not.toHaveProperty("rankingReasonsOmitted");
    expect(JSON.stringify(response.candidates)).toContain("xxxx");
  });

  it("drops an offering's endDate with its endTime", () => {
    const late = result(3, true);
    for (const entry of late.candidates) entry.offerings = entry.offerings.map(offering => ({ ...offering, endTime: "00:30", endDate: "2026-12-03" }));
    expect(JSON.stringify(buildMatchResponse(late, 3).candidates)).toContain("endDate");
    const bare = size(buildMatchResponse(result(3, false), 3));
    const response = buildMatchResponse(late, 3, fitsUnder(bare));
    expect(JSON.stringify(response.candidates)).not.toContain("endDate");
    expect(JSON.stringify(response.candidates)).not.toContain("endTime");
  });

  it("drops the ranking reasons next, keeping the end times while they fit", () => {
    const withEndsNoRanking = size({ ...buildMatchResponse(result(8, true), 8, fitsUnder(1)), candidates: [] });
    expect(withEndsNoRanking).toBeGreaterThan(0);
    const noRankingBudget = size(buildMatchResponse(result(8, true), 8, (value) => !JSON.stringify(value).includes("xxxx")));
    const response = buildMatchResponse(result(8, true), 8, fitsUnder(noRankingBudget));
    expect(response.returned).toBe(8);
    expect(response.rankingReasonsOmitted).toBe(true);
    expect(hasEnds(response)).toBe(true);
  });

  it("returns exactly the candidates a response without end times would, at every budget", () => {
    const sizes = Array.from({ length: 60 }, (_, step) => 1500 + step * 400);
    for (const budget of sizes) {
      const withEnds = buildMatchResponse(result(30, true), 30, fitsUnder(budget));
      const without = buildMatchResponse(result(30, false), 30, fitsUnder(budget));
      expect(withEnds.returned, `budget ${budget}`).toBe(without.returned);
      expect(withEnds.candidates.map(entry => entry.code), `budget ${budget}`).toEqual(without.candidates.map(entry => entry.code));
      expect(withEnds.truncated, `budget ${budget}`).toBe(without.truncated);
    }
  });

  it("does the same for a focus", () => {
    const focus = (withEnd: boolean): FocusResult => ({ results: [3, 4].map((count, index) => ({ topic: `service:S${index}`, goal: "deepen" as const, total: count, candidates: Array.from({ length: count }, (_, i) => candidate(`F${index}${i}`, withEnd)) })) });
    const bare = size(buildFocusResponse(focus(false)));
    expect(size(buildFocusResponse(focus(true)))).toBeGreaterThan(bare);
    const response = buildFocusResponse(focus(true), fitsUnder(bare));
    expect(response.omitted).toBe(0);
    expect(JSON.stringify(response.results)).not.toContain("endTime");
    const noRankingBudget = size(buildFocusResponse(focus(true), (value) => !JSON.stringify(value).includes("xxxx")));
    const reasonsGone = buildFocusResponse(focus(true), fitsUnder(noRankingBudget));
    expect(reasonsGone.omitted).toBe(0);
    expect(reasonsGone.rankingReasonsOmitted).toBe(true);
    expect(JSON.stringify(reasonsGone.results)).toContain("endTime");
    for (const budget of Array.from({ length: 40 }, (_, step) => 2500 + step * 300)) {
      expect(buildFocusResponse(focus(true), fitsUnder(budget)).omitted, `budget ${budget}`).toBe(buildFocusResponse(focus(false), fitsUnder(budget)).omitted);
    }
  });
});
