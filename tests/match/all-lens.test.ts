import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import { buildMatchResponse, toLeanCandidate } from "../../src/match/response.js";
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
  ({ sessionId: code, abbreviation: code, title, level: "300 - Advanced", type: "Breakout session", ...extra });

describe("the all lens", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  function run(p: ResolvedProfile, raw: Session[], limit?: number) {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    return matchSessionsDetailed(p, { storeRoot: home.path }, { ...(limit === undefined ? {} : { limit }) });
  }
  const codes = (result: ReturnType<typeof run>) => result.candidates.map(candidate => candidate.code);

  it("is the default lens and lists sessions of any level about a concept of the profile", () => {
    const result = run(profile(["Amazon DynamoDB"]), [
      session("NAM100", "Getting started with DynamoDB", { level: "100 - Foundational" }),
      session("NAM400", "DynamoDB internals", { level: "400 - Expert" }),
    ]);
    expect(codes(result).sort()).toEqual(["NAM100", "NAM400"]);
  });

  it("admits a session only for a concept it names, never for a tag, a listed service or shared wording", () => {
    const result = run(profile(["Amazon DynamoDB"], ["serverless"]), [
      session("NAM300", "DynamoDB data modeling"),
      session("TAG300", "Databases for everyone", { services: ["Amazon DynamoDB"], topics: ["Serverless"] }),
      session("TXT300", "Keys and tables", { abstract: "Partition keys, tables and streams for your data." }),
      session("ONE300", "Data at scale", { services: ["Amazon DynamoDB"], abstract: "You will use DynamoDB tables." }),
      session("BAR300", "Data at rest", { abstract: "You will use DynamoDB tables." }),
    ]);
    expect(codes(result).sort()).toEqual(["NAM300", "ONE300"]);
  });

  it("returns nothing for a profile with no concept any session is about", () => {
    const result = run(profile(["Playwright"]), [session("LAM300", "Lambda internals")]);
    expect(result.candidates).toEqual([]);
    expect(result.uncovered).toBeUndefined();
  });

  it("skips an AWS Partner bootcamp and certification sessions", () => {
    const result = run(profile(["Amazon DynamoDB"]), [
      session("PAR300", "AWS Partner: DynamoDB bootcamp"), session("CER300", "DynamoDB certification practice"),
      session("EXM300", "DynamoDB questions", { type: "Exam prep" }), session("OKK300", "DynamoDB data modeling"),
    ]);
    expect(codes(result)).toEqual(["OKK300"]);
  });

  it("ranks a demoted session after an undemoted one, and says why", () => {
    const result = run(profile(["AWS Lambda"]), [
      session("SPN300-S", "Lambda at scale (sponsored by Acme)"),
      session("NEW300", "What's new in Lambda"),
      session("STO300", "Acme: How we ran Lambda at scale"),
      session("OKK300", "Lambda at scale"),
    ]);
    expect(codes(result)[0]).toBe("OKK300");
    const reasons = Object.fromEntries(result.candidates.map(candidate => [candidate.code, toLeanCandidate(candidate).demoted]));
    expect(reasons).toEqual({ OKK300: undefined, NEW300: "news or launch session", "SPN300-S": "sponsored session", STO300: "customer story" });
    const sponsored = result.candidates.find(candidate => candidate.code === "SPN300-S")!;
    expect(sponsored.why.summary).toBe("Matches your AWS Lambda; ranked lower: sponsored session.");
  });

  it("demotes a session titled about agents when the profile has no agentic pattern, and not when it has", () => {
    const sessions = [session("AGT300", "Building agentic apps on Lambda"), session("LAM300", "Lambda in practice")];
    expect(codes(run(profile(["AWS Lambda"]), sessions))).toEqual(["LAM300", "AGT300"]);
    expect(run(profile(["AWS Lambda"]), sessions).candidates.map(candidate => candidate.demoted)).toEqual([undefined, "about agents, which this code does not use"]);
    const agentic = run(profile(["AWS Lambda"], ["agentic"]), sessions);
    expect(agentic.candidates.map(candidate => candidate.demoted)).toEqual([undefined, undefined]);
  });

  it("returns a session for a stated interest, after the sessions about the profile's evidence, and says so", () => {
    const p = { ...profile(["AWS Lambda"]), interests: ["Edge Computing"] };
    const result = run(p, [
      session("EDG300", "Faster pages", { areasOfInterest: ["Edge Computing"] }),
      session("TIT300", "Edge Computing in practice"),
      session("LAM300", "Lambda in practice"),
    ]);
    expect(codes(result)).toEqual(["LAM300", "TIT300", "EDG300"]);
    const tagged = result.candidates[2]!;
    expect(tagged.why.summary).toBe("Matches your interest in Edge Computing.");
    expect(tagged.why.yourCode).toEqual([]);
    expect(tagged.why.sessionSays).toBeUndefined();
    expect(tagged.reasons[0]!.detail).toBe('Matches your interest in Edge Computing ("Edge Computing").');
  });

  it("does not use intents, and a profile with only an interest nothing names returns nothing", () => {
    const p = { ...profile([]), interests: ["Edge Computing"], intents: [{ kind: "goal" as const, text: "Lambda basics" }] };
    expect(codes(run(p, [session("LAM300", "Lambda in practice", { abstract: "Edge Computing is mentioned. Edge Computing again." })]))).toEqual([]);
  });

  it("names a story about a company told in the abstract, whatever the title", () => {
    const result = run(profile(["AWS Lambda"]), [
      session("STO300", "Lambda at every scale", { abstract: "Honeycomb spends millions of dollars a year on Lambda. We outgrew it." }),
      session("OKK300", "Lambda in practice"),
    ]);
    expect(codes(result)).toEqual(["OKK300", "STO300"]);
    expect(result.candidates[1]!.demoted).toBe("customer story");
  });

  it("does not demote a session about agents when the profile's interest names them", () => {
    const sessions = [session("AGT300", "Agents on Lambda"), session("LAM300", "Lambda in practice")];
    const interested = run({ ...profile(["AWS Lambda"]), interests: ["Agentic AI"] }, sessions);
    expect(interested.candidates.map(candidate => candidate.demoted)).toEqual([undefined, undefined]);
    expect(run(profile(["AWS Lambda"]), sessions).candidates.map(candidate => candidate.demoted)).toContain("about agents, which this code does not use");
  });

  it("does not match a pattern through a service's name", () => {
    const sessions = [session("GWY300", "API Gateway unleashed"), session("API300", "REST API design")];
    expect(codes(run(profile([], ["api"]), sessions))).toEqual(["API300"]);
    expect(codes(run(profile(["Amazon API Gateway"], ["api"]), sessions)).sort()).toEqual(["API300", "GWY300"]);
  });

  it("does not take a title about how a service works for a customer story", () => {
    const result = run(profile(["Kiro"]), [session("KIR300", "How Kiro learns your code"), session("CUS300", "How Acme scaled Kiro")]);
    expect(Object.fromEntries(result.candidates.map(candidate => [candidate.code, candidate.demoted]))).toEqual({ KIR300: undefined, CUS300: "customer story" });
  });

  it("demotes an industry session that names its industry in a build title, using the catalog's industry names", () => {
    const result = run(profile(["AWS Lambda"]), [
      session("GOV300", "Build government data planes on Lambda", { industries: ["Government"] }),
      session("RET300", "Build a flash-sale control plane on Lambda", { industries: ["Retail & Consumer Goods"] }),
    ]);
    expect(Object.fromEntries(result.candidates.map(candidate => [candidate.code, candidate.demoted]))).toEqual({ GOV300: "industry session", RET300: undefined });
  });

  it("lets a rare service a session only lists add weight, but only for a profile that measured footprints", () => {
    const raw = [
      session("AAA300", "Serverless platform notes", { abstract: "Serverless design. Serverless again. Kiro CLI, Claude Code, and Codex." }),
      session("BBB300", "Serverless platform notes two", { abstract: "Serverless design. Serverless again." }),
    ];
    const claude = (footprint?: number) => ({ ...profile(["AWS Lambda", "Claude Code"], ["serverless"]), ...(footprint === undefined ? {} : { patterns: [{ name: "serverless", footprint, evidence: [cite("p.ts", 7)] }] }) });
    const weights = (p: ResolvedProfile) => Object.fromEntries(run(p, [...raw, ...Array.from({ length: 60 }, (_, i) => session(`ZZZ${i}`, `Filler ${i}`))]).candidates.map(candidate => [candidate.code, candidate.reasons.length]));
    expect(weights(claude())).toEqual({ AAA300: 1, BBB300: 1 });
    expect(weights(claude(2))).toEqual({ AAA300: 2, BBB300: 1 });
  });

  it("demotes a session about a technology the code does not use, and says which", () => {
    const sessions = [
      session("TER300", "Building serverless applications with Terraform"), session("LAM300", "Building serverless applications"),
      session("VS300", "Lambda vs Terraform: serverless applications", { services: ["AWS Lambda"] }),
    ];
    const result = run(profile(["AWS Lambda"], ["serverless"]), sessions);
    expect(Object.fromEntries(result.candidates.map(candidate => [candidate.code, candidate.demoted]))).toEqual({ LAM300: undefined, VS300: undefined, TER300: "about Terraform, which this code does not use" });
    expect(result.candidates.find(candidate => candidate.code === "TER300")!.why.summary).toContain("ranked lower: about Terraform, which this code does not use");
    expect(codes(result)[2]).toBe("TER300");
    const usesIt = run({ ...profile(["AWS Lambda", "Terraform"], ["serverless"]) }, sessions);
    expect(usesIt.candidates.map(candidate => candidate.demoted)).toEqual([undefined, undefined, undefined]);
  });

  it("ranks a session about the code's central concept above one about a rare concept", () => {
    const p = profile(["AWS Lambda", "Amazon Cognito"]);
    p.services[0]!.evidence = [cite("a.ts"), cite("b.ts"), cite("c.ts")];
    expect(codes(run(p, [session("COG300", "Cognito in depth"), session("LAM300", "Lambda in depth")]))).toEqual(["LAM300", "COG300"]);
  });

  it("names the concepts the session was admitted for and quotes the sentence that says it", () => {
    const p = profile(["AWS Lambda", "Amazon DynamoDB"]);
    p.services[0]!.evidence = [cite("a.ts"), cite("b.ts"), cite("c.ts")];
    const result = run(p, [
      session("LAM300", "Lambda and DynamoDB together", { abstract: "Scale it. Build with Lambda functions in front of DynamoDB tables." }),
    ]);
    const { why } = result.candidates[0]!;
    expect(why.summary).toBe("Matches your AWS Lambda and Amazon DynamoDB.");
    expect(why.sessionSays).toBe("Build with Lambda functions in front of DynamoDB tables.");
    expect(why.yourCode.length).toBeGreaterThan(0);
  });

  it("gives every candidate a reason per concept, summing to its score", () => {
    const result = run(profile(["AWS Lambda", "Amazon DynamoDB"]), [session("LAM300", "Lambda and DynamoDB together")]);
    const candidate = result.candidates[0]!;
    expect(candidate.reasons.map(reason => reason.kind)).toEqual(["matchesConcept", "matchesConcept"]);
    expect(candidate.score).toBe(candidate.reasons.reduce((sum, reason) => sum + reason.weight, 0));
  });

  it("groups repeat sittings into one candidate with every offering", () => {
    const result = run(profile(["AWS Lambda"]), [session("LAM300", "Lambda basics"), session("LAM300-R", "Lambda basics [REPEAT]")]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.offerings).toHaveLength(2);
  });

  it("keeps no more than three sessions of one concept in the top ten, while four concepts have sessions", () => {
    const lambdas = Array.from({ length: 6 }, (_, index) => session(`LAM30${index}`, `Lambda topic ${index}`));
    const others = ["Amazon DynamoDB", "Amazon Cognito", "Amazon SQS"].map((name, index) => session(`OTH30${index}`, `${name.replace("Amazon ", "")} topic`));
    const p = profile(["AWS Lambda", "Amazon DynamoDB", "Amazon Cognito", "Amazon SQS"]);
    p.services[0]!.evidence = [cite("a.ts"), cite("b.ts"), cite("c.ts")];
    const top = codes(run(p, [...lambdas, ...others]));
    expect(top.slice(0, 6).filter(code => code.startsWith("LAM"))).toHaveLength(3);
    expect(top).toHaveLength(9);
  });

  it("applies the limit after ranking", () => {
    const result = run(profile(["AWS Lambda"]), [session("AAA300", "Lambda one"), session("BBB300", "Lambda two")], 1);
    expect(codes(result)).toEqual(["AAA300"]);
  });

  it("carries the demotion through the shared response, and leaves it off an undemoted candidate", () => {
    const result = run(profile(["AWS Lambda"]), [session("OKK300", "Lambda basics"), session("NEW300", "What's new in Lambda")]);
    const response = buildMatchResponse(result, 10);
    expect(response.candidates.map(candidate => "demoted" in candidate)).toEqual([false, true]);
  });
});
