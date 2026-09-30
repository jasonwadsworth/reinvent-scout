import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import { buildMatchResponse } from "../../src/match/response.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line = 1) => ({ repo: "repo", file, line });
const profile = (services: string[], patterns: string[] = []): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: services.map((name, index) => ({ name, catalogName: name, evidence: [cite(`svc${index}.ts`, index + 1), cite("shared.ts")] })),
  patterns: patterns.map(name => ({ name, evidence: [cite("p.ts", 7)] })),
  unresolvedServices: [],
});
const session = (code: string, title: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level: "200 - Intermediate", type: "Breakout session", ...extra });

describe("the explain lens", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  function run(p: ResolvedProfile, raw: Session[], limit?: number) {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    return matchSessionsDetailed(p, { storeRoot: home.path }, { lens: "explain", ...(limit === undefined ? {} : { limit }) });
  }
  const codes = (result: ReturnType<typeof run>) => result.candidates.map(candidate => candidate.code);

  it("admits a session only for a concept it names, never for a tag or a listed service", () => {
    const result = run(profile(["Amazon DynamoDB"]), [
      session("NAM100", "Getting started with DynamoDB"),
      session("TAG100", "Databases for everyone", { services: ["Amazon DynamoDB"], topics: ["Databases"] }),
      session("ABS100", "Data at scale", { abstract: "You will use DynamoDB tables. DynamoDB streams too." }),
    ]);
    expect(codes(result).sort()).toEqual(["ABS100", "NAM100"]);
  });

  it("names the concept and the code that uses it in the reason", () => {
    const result = run(profile(["Amazon DynamoDB"]), [session("NAM100", "Getting started with DynamoDB")]);
    const reason = result.candidates[0]!.reasons.find(entry => entry.kind === "explainsConcept")!;
    expect(reason.detail).toBe('Explains Amazon DynamoDB ("DynamoDB"), which this code uses at svc0.ts:1, shared.ts:1.');
    expect(reason.profileEvidence).toEqual([cite("svc0.ts", 1), cite("shared.ts")]);
    expect(result.candidates[0]!.score).toBe(result.candidates[0]!.reasons.reduce((sum, entry) => sum + entry.weight, 0));
  });

  it("covers distinct concepts before repeating one", () => {
    const result = run(profile(["AWS Lambda", "Amazon DynamoDB", "Amazon Cognito"]), [
      session("LAM100", "Lambda basics"), session("LAM101", "More Lambda"), session("LAM102", "Lambda tips"),
      session("DDB100", "DynamoDB basics"), session("COG100", "Cognito basics"),
    ], 3);
    expect(codes(result).sort()).toEqual(["COG100", "DDB100", "LAM100"]);
  });

  it("puts the most cited concept first", () => {
    const p = profile(["AWS Lambda", "Amazon DynamoDB"]);
    p.services[1]!.evidence = [cite("a.ts"), cite("b.ts"), cite("c.ts"), cite("d.ts")];
    expect(codes(run(p, [session("LAM100", "Lambda basics"), session("DDB100", "DynamoDB basics")]))).toEqual(["DDB100", "LAM100"]);
  });

  it("groups repeat sittings into one candidate with every offering", () => {
    const result = run(profile(["AWS Lambda"]), [session("LAM100", "Lambda basics"), session("LAM100-R", "Lambda basics [REPEAT]")]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.offerings).toHaveLength(2);
    expect(result.candidates[0]!.record.title).toBe("Lambda basics");
  });

  it("takes one 300-level session for a concept with no introductory one, and says so", () => {
    const result = run(profile(["AWS Lambda", "Amazon DynamoDB"]), [
      session("LAM100", "Lambda basics"), session("LAM300", "Lambda internals", { level: "300 - Advanced" }),
      session("DDB300", "DynamoDB design", { level: "300 - Advanced" }), session("DDB301", "DynamoDB modeling", { level: "300 - Advanced" }),
      session("DDB400", "DynamoDB at the limit", { level: "400 - Expert" }),
    ]);
    expect(codes(result).sort()).toEqual(["DDB300", "LAM100"]);
    expect(result.candidates.find(candidate => candidate.code === "DDB300")!.reasons[0]!.detail).toContain("300-level");
  });

  it("reports a concept no session explains, and a pattern it cannot match, always as a list", () => {
    const result = run(profile(["AWS Lambda", "Amazon Cognito"], ["mcp-server", "gap-no-dlq", "dead-code"]), [session("LAM100", "Lambda basics")]);
    expect(result.uncovered).toEqual([
      { concept: "Amazon Cognito", reason: "no introductory (100/200) or 300-level session is about it" },
      { concept: "mcp-server", reason: "no session phrase is defined for this pattern, so no session can be matched to it" },
    ]);
    expect(run(profile(["AWS Lambda"]), [session("LAM100", "Lambda basics")]).uncovered).toEqual([]);
  });

  it("returns nothing but the uncovered list for a profile no session is about", () => {
    const result = run(profile(["Playwright"]), [session("LAM100", "Lambda basics")]);
    expect(result.candidates).toEqual([]);
    expect(result.uncovered).toEqual([{ concept: "Playwright", reason: "no introductory (100/200) or 300-level session is about it" }]);
  });

  it("leaves the other lenses without an uncovered list", () => {
    writeCatalog({ raw: [session("LAM100", "Lambda basics")], index: [buildIndexRecord(session("LAM100", "Lambda basics"))], meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: 1, count: 1, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    for (const lens of ["all", "fix", "next-level"] as const) {
      expect(matchSessionsDetailed(profile(["AWS Lambda"]), { storeRoot: home.path }, { lens }).uncovered).toBeUndefined();
    }
  });

  it("carries the uncovered list through the shared response, including when it is truncated", () => {
    const result = run(profile(["AWS Lambda", "Amazon Cognito"]), [session("LAM100", "Lambda basics"), session("LAM101", "More Lambda")]);
    const full = buildMatchResponse(result, 10);
    expect(full.uncovered).toEqual(result.uncovered);
    const truncated = buildMatchResponse(result, 10, value => JSON.stringify(value).length < 1);
    expect(truncated.truncated).toBe(true);
    expect(truncated.uncovered).toEqual(result.uncovered);
  });
});
