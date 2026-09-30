import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import type { MatchCandidate, MatchResult } from "../../src/match/match.js";
import { buildMatchResponse } from "../../src/match/response.js";
import type { Reason } from "../../src/match/score.js";

const reason = (kind: Reason["kind"], detail: string): Reason => ({ kind, detail, weight: 1, evidence: "e" });
const candidate = (code: string): MatchCandidate => ({
  code,
  record: buildIndexRecord({ sessionId: code, abbreviation: code, title: `Session ${code}` }),
  score: 10,
  reasons: [reason("service", `service ${"x".repeat(400)}`), reason("text", `text ${"y".repeat(400)}`), reason("pillarGap", "gap reason")],
  offerings: [],
  why: { summary: `Covers your gap: ${code}.`, yourCode: [{ repo: "r", file: "f.ts", line: 1 }], sessionSays: `A sentence from ${code}.` },
});
const result = (count: number): MatchResult =>
  ({ candidates: Array.from({ length: count }, (_, i) => candidate(`C${i}`)), skippedRules: [] });
const size = (value: unknown): number => JSON.stringify(value).length;

describe("buildMatchResponse budget order", () => {
  it("keeps everything when it fits", () => {
    const response = buildMatchResponse(result(3), 3, () => true);
    expect(response.rankingReasonsOmitted).toBeUndefined();
    expect((response.candidates[0]!.reasons as unknown[]).length).toBe(3);
  });

  it("drops ranking reasons from every candidate before it drops a candidate", () => {
    const full = size(buildMatchResponse(result(5), 5));
    const response = buildMatchResponse(result(5), 5, value => size(value) < full - 500);
    expect(response.truncated).toBe(false);
    expect(response.returned).toBe(5);
    expect(response.rankingReasonsOmitted).toBe(true);
    for (const entry of response.candidates) {
      expect((entry.reasons as Array<{ kind: string }>).map(each => each.kind)).toEqual(["pillarGap"]);
      expect((entry.why as { sessionSays: string }).sessionSays).toMatch(/^A sentence from C\d\.$/);
    }
  });

  it("then drops candidates, still whole, with why and its quote intact on the ones kept", () => {
    const one = size(buildMatchResponse(result(1), 1, () => true, candidateWithoutRanking));
    const response = buildMatchResponse(result(5), 5, value => size(value) < one * 2.5);
    expect(response.truncated).toBe(true);
    expect(response.returned).toBeGreaterThan(0);
    expect(response.returned).toBeLessThan(5);
    expect(response.rankingReasonsOmitted).toBe(true);
    expect(response.candidates.map(entry => entry.code)).toEqual(["C0", "C1", "C2", "C3", "C4"].slice(0, response.returned));
    for (const entry of response.candidates) {
      expect((entry.why as { sessionSays?: string }).sessionSays).toBeDefined();
    }
  });
});

function candidateWithoutRanking(entry: MatchCandidate): Record<string, unknown> {
  return buildMatchResponse({ candidates: [{ ...entry, reasons: entry.reasons.filter(each => each.kind === "pillarGap") }], skippedRules: [] }, 1).candidates[0]!;
}
