import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import type { FocusCandidate, FocusResult } from "../../src/match/focus.js";
import type { MapTopic, ProfileMap } from "../../src/match/map.js";
import { buildFocusResponse, buildMapResponse } from "../../src/match/response.js";

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

describe("buildMapResponse", () => {
  const topic = (id: string): MapTopic => ({
    id, label: id, note: "n".repeat(120), evidence: [{ repo: "r", file: "a.ts", line: 1 }, { repo: "r", file: "b.ts", line: 2 }], more: 4,
    goals: [{ goal: "deepen", sessions: 3 }],
  });
  const map: ProfileMap = { services: [topic("service:A"), topic("service:B")], patterns: [topic("pattern:c")], gaps: [], nextSteps: [] };
  const size = (value: unknown): number => JSON.stringify(value).length;

  it("keeps the whole map when it fits", () => {
    expect(buildMapResponse(map)).toBe(map);
  });

  it("trims to one place per topic first, then to none without the more count, then without notes, and never drops a topic or a goal", () => {
    const one = buildMapResponse(map, value => size(value) < size(map));
    expect(one.services[0]!.evidence).toHaveLength(1);
    expect(one.services[0]!.more).toBe(4);
    expect(one.services[0]!.note).toBeDefined();
    const none = buildMapResponse(map, value => size(value) < size(one));
    expect(none.services[0]!.evidence).toEqual([]);
    expect(none.services[0]).not.toHaveProperty("more");
    expect(none.services[0]!.note).toBeDefined();
    const bare = buildMapResponse(map, () => false);
    expect(bare.services[0]).not.toHaveProperty("note");
    expect(bare.services.map(entry => entry.id)).toEqual(["service:A", "service:B"]);
    expect(bare.services[0]!.goals).toEqual([{ goal: "deepen", sessions: 3 }]);
  });
});
