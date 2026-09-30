import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import type { FocusCandidate, FocusResult } from "../../src/match/focus.js";
import { buildFocusResponse } from "../../src/match/response.js";

const candidate = (code: string, extra: Partial<FocusCandidate> = {}): FocusCandidate => ({
  code,
  record: buildIndexRecord({ sessionId: code, abbreviation: code, title: `Title ${code}`, type: "Chalk talk", level: "200 - Intermediate" }),
  score: 1, offerings: [], why: { summary: "Matches.", yourCode: [] },
  reasons: [{ kind: "service", detail: "x".repeat(200), weight: 1, evidence: "x" }, { kind: "explainsConcept", detail: "kept", weight: 1, evidence: "y" }],
  ...extra,
});
const result = (sizes: number[]): FocusResult => ({
  results: sizes.map((size, index) => ({ topic: `service:S${index}`, goal: "deepen" as const, total: size + 3, candidates: Array.from({ length: size }, (_, i) => candidate(`C${index}${i}`)) })),
});
const fitsUnder = (bytes: number) => (value: unknown): boolean => JSON.stringify(value).length <= bytes;

describe("buildFocusResponse", () => {
  it("keeps everything when it fits", () => {
    const response = buildFocusResponse(result([2, 2]));
    expect(response).toMatchObject({ truncated: false, omitted: 0 });
    expect(response.results.map(entry => entry.candidates.length)).toEqual([2, 2]);
    expect(response).not.toHaveProperty("rankingReasonsOmitted");
  });

  it("carries the topic, goal, total, reason and alsoMatches", () => {
    const response = buildFocusResponse({ results: [{ topic: "gap:gap-no-dlq", goal: "improve", total: 0, candidates: [], reason: "no session" }, { topic: "service:A", goal: "deepen", total: 1, candidates: [candidate("X", { alsoMatches: ["service:B"] })] }] });
    expect(response.results[0]).toEqual({ topic: "gap:gap-no-dlq", goal: "improve", total: 0, candidates: [], reason: "no session" });
    expect(response.results[1]!.candidates[0]).toMatchObject({ code: "X", alsoMatches: ["service:B"] });
  });

  it("drops ranking reasons from every candidate before it drops a session", () => {
    const full = JSON.stringify(buildFocusResponse(result([3, 3]))).length;
    const response = buildFocusResponse(result([3, 3]), fitsUnder(full - 100));
    expect(response.rankingReasonsOmitted).toBe(true);
    expect(response.truncated).toBe(false);
    for (const entry of response.results) for (const found of entry.candidates) expect((found.reasons as Array<{ kind: string }>).map(reason => reason.kind)).toEqual(["explainsConcept"]);
  });

  it("then drops sessions from the end of the longest list, one at a time, and counts them", () => {
    const full = JSON.stringify(buildFocusResponse(result([4, 2]))).length;
    const withoutRanking = JSON.stringify(buildFocusResponse(result([4, 2]), fitsUnder(full - 1))).length;
    const response = buildFocusResponse(result([4, 2]), fitsUnder(Math.floor(withoutRanking * 0.7)));
    expect(response.truncated).toBe(true);
    expect(response.omitted).toBeGreaterThan(0);
    const [first, second] = response.results.map(entry => entry.candidates.map(found => found.code));
    expect(first![0]).toBe("C00");
    expect(second![0]).toBe("C10");
    expect(first!.length + second!.length).toBe(6 - response.omitted);
  });

  it("never partly serializes: with nothing fitting it ends with every list empty", () => {
    const response = buildFocusResponse(result([2, 2]), fitsUnder(1));
    expect(response.results.every(entry => entry.candidates.length === 0)).toBe(true);
    expect(response.omitted).toBe(4);
  });
});
