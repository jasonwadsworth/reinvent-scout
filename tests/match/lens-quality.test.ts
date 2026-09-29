import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { matchSessionsDetailed, type MatchCandidate } from "../../src/match/match.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const lensFixture: Session[] = JSON.parse(readFileSync(join(here, "..", "fixtures", "catalog-lens-sample.json"), "utf8"));
const evidence = [{ repo: "repo", file: "stack.ts", line: 3 }];

const profile = (patterns: string[], services: string[] = []): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: services.map(catalogName => ({ name: catalogName, catalogName, evidence })),
  patterns: patterns.map(name => ({ name, evidence })), unresolvedServices: [],
});
const hallwayServices = ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)", "Amazon DynamoDB", "Amazon EventBridge", "AWS Step Functions"];
const codes = (candidates: MatchCandidate[]) => candidates.map(candidate => candidate.code.replace(/-R\d*$/, ""));

describe("lens quality on real abstracts", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  function seed(raw: Session[]): void {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  }
  const run = (p: ResolvedProfile, lens: "fix" | "next-level", limit?: number) =>
    matchSessionsDetailed(p, { storeRoot: home.path }, { lens, ...(limit === undefined ? {} : { limit }) });

  describe("Fix", () => {
    const hallway = profile(["gap-no-dlq", "gap-no-alarms", "gap-no-tests", "gap-broad-iam"], hallwayServices);
    it("puts the precise DLQ session in the top 5 and the tests and IAM sessions in the top 10", () => {
      seed(lensFixture);
      const top = codes(run(hallway, "fix").candidates);
      expect(top.indexOf("API311")).toBeGreaterThanOrEqual(0);
      expect(top.indexOf("API311")).toBeLessThan(5);
      expect(top.indexOf("SVS329")).toBeLessThan(10);
      expect(top.indexOf("SVS314")).toBeLessThan(10);
    });
    it("does not admit passing mentions for alarms or broad IAM", () => {
      seed(lensFixture);
      const byCode = new Map(run(hallway, "fix").candidates.map(candidate => [candidate.code.replace(/-R\d*$/, ""), candidate]));
      for (const code of ["SVS317", "SVS325", "COM324", "SVS336", "COM201"]) {
        expect(byCode.get(code)?.lensRules ?? []).not.toContain("gap-no-alarms");
        expect(byCode.get(code)?.lensRules ?? []).not.toContain("gap-broad-iam");
      }
    });
    it("records every rule that admitted a session, once, at its earliest position", () => {
      seed(lensFixture);
      const { candidates } = run(hallway, "fix");
      expect(new Set(candidates.map(candidate => candidate.code)).size).toBe(candidates.length);
      const api = candidates.find(candidate => candidate.code.startsWith("API311"))!;
      expect(api.lensRules).toEqual(["gap-no-dlq"]);
      expect(api.offerings).toHaveLength(2);
    });
  });

  describe("Next-level", () => {
    const serverless = profile(["serverless"], ["AWS Lambda", "AWS Step Functions"]);
    it("admits genuine serverless-to-containers sessions and excludes reverse and passing ones", () => {
      seed(lensFixture);
      const top = codes(run(serverless, "next-level").candidates);
      expect(top).toContain("SVS320");
      expect(top).toContain("COM320");
      for (const code of ["COM340", "SVS207", "COM303", "AMZ401"]) expect(top).not.toContain(code);
    });
    it("skips genai-single-call to agentic when the profile already has agentic", () => {
      seed(lensFixture);
      const result = run(profile(["genai-single-call", "agentic"]), "next-level");
      expect(result.candidates).toEqual([]);
      expect(result.skippedRules).toEqual([{ rule: "genai-single-call", reason: "profile already has agentic" }]);
    });
    it("without agentic, admits title-level agentic sessions and not a tag-only build talk", () => {
      seed(lensFixture);
      const result = run(profile(["genai-single-call"]), "next-level");
      const top = codes(result.candidates);
      expect(top).toContain("SVS324");
      expect(top).not.toContain("IND3320");
      expect(result.skippedRules).toEqual([]);
    });
  });

  describe("interleaving", () => {
    it("gives each activated rule a session in the top 2 even when one rule has far more relevant sessions", () => {
      const raw: Session[] = [
        ...["A", "B", "C"].map(letter => ({ sessionId: `dlq${letter}`, abbreviation: `DLQ10${letter}`, title: "Dead-letter queues", services: ["AWS Lambda"] })),
        { sessionId: "iam", abbreviation: "IAM100", title: "Least privilege IAM policies", abstract: "Runs on Lambda." },
      ];
      seed(raw);
      const p = profile(["gap-no-dlq", "gap-broad-iam"], ["AWS Lambda"]);
      expect(codes(run(p, "fix", 2).candidates).sort()).toEqual(["DLQ10A", "IAM100"].sort());
    });
    it("ranks within a rule by strength before profile relevance", () => {
      const raw: Session[] = [
        { sessionId: "weak", abbreviation: "WEAK100", title: "Queues", abstract: "Covers dead-letter queues once.", services: ["AWS Lambda"] },
        { sessionId: "strong", abbreviation: "STRONG100", title: "Dead-letter queues", abstract: "Lambda consumers." },
      ];
      seed(raw);
      expect(codes(run(profile(["gap-no-dlq"], ["AWS Lambda"]), "fix").candidates)).toEqual(["STRONG100", "WEAK100"]);
    });
  });

  describe("stack gate", () => {
    const raw: Session[] = [
      { sessionId: "on", abbreviation: "ON100", title: "Dead-letter queues", services: ["AWS Lambda"] },
      { sessionId: "text", abbreviation: "TEXT100", title: "Dead-letter queues", abstract: "Covers SQS consumers." },
      { sessionId: "off", abbreviation: "OFF100", title: "Dead-letter queues", services: ["Amazon Aurora"], abstract: "Database failover." },
      { sessionId: "gateway", abbreviation: "GATE100", title: "Dead-letter queues", abstract: "API Gateway integrations." },
    ];
    const service = (name: string, catalogName: string, role?: "core" | "supporting") => ({ name, catalogName, evidence, ...(role === undefined ? {} : { role }) });
    const withServices = (services: ResolvedProfile["services"]): ResolvedProfile => ({ ...profile(["gap-no-dlq"]), services });
    it("admits only sessions that list or name a core service", () => {
      seed(raw);
      const p = withServices([service("lambda", "AWS Lambda"), service("sqs", "Amazon Simple Queue Service (Amazon SQS)")]);
      expect(codes(run(p, "fix").candidates).sort()).toEqual(["ON100", "TEXT100"]);
    });
    it("does not let a supporting service admit a session", () => {
      seed(raw);
      const p = withServices([service("lambda", "AWS Lambda"), service("apigateway", "Amazon API Gateway", "supporting")]);
      expect(codes(run(p, "fix").candidates)).toEqual(["ON100"]);
    });
    it("is off for a profile with no core service", () => {
      seed(raw);
      expect(codes(run(profile(["gap-no-dlq"]), "fix").candidates)).toHaveLength(4);
    });
  });
});
