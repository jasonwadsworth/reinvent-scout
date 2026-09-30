import { describe, expect, it } from "vitest";
import { buildConcepts } from "../../src/match/concepts.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const cite = (file: string) => ({ repo: "repo", file, line: 1 });
interface Entry { name: string; catalogName?: string | null; role?: "core" | "supporting"; files?: string[]; footprint?: number }
const profile = (services: Entry[], patterns: Array<{ name: string; files?: string[]; footprint?: number }> = []): ResolvedProfile => ({
  schemaVersion: 1,
  repos: [{ root: "repo", languages: [] }],
  services: services.map(service => ({
    name: service.name, catalogName: service.catalogName === undefined ? service.name : service.catalogName,
    ...(service.role === undefined ? {} : { role: service.role }),
    ...(service.footprint === undefined ? {} : { footprint: service.footprint }),
    evidence: (service.files ?? ["a.ts"]).map(file => cite(file)),
  })),
  patterns: patterns.map(pattern => ({
    name: pattern.name, ...(pattern.footprint === undefined ? {} : { footprint: pattern.footprint }),
    evidence: (pattern.files ?? ["a.ts"]).map(file => cite(file)),
  })),
  unresolvedServices: [],
});
const centralities = (p: ResolvedProfile) => Object.fromEntries(buildConcepts(p).concepts.map(concept => [concept.name, concept.centrality]));

describe("centrality with footprints", () => {
  it("keeps the distinct cited-file count when no entry has a footprint", () => {
    expect(centralities(profile([{ name: "AWS Lambda", files: ["a.ts", "b.ts", "c.ts"] }, { name: "Amazon DynamoDB" }], [{ name: "serverless", files: ["a.ts", "b.ts"] }])))
      .toEqual({ "AWS Lambda": 3, "Amazon DynamoDB": 1, serverless: 2 });
  });

  it("is log2(1 + footprint) for every concept once any entry has one, the cited count standing in where one is missing", () => {
    const c = centralities(profile(
      [{ name: "AWS Lambda", footprint: 7 }, { name: "Amazon DynamoDB", files: ["a.ts", "b.ts", "c.ts"] }],
      [{ name: "serverless", footprint: 0 }],
    ));
    expect(c["AWS Lambda"]).toBe(3);
    expect(c["Amazon DynamoDB"]).toBe(2);
    expect(c["serverless"]).toBe(0);
  });

  it("prefers the footprint over the cited files, so one citation of a widely used service ranks high", () => {
    const { concepts } = buildConcepts(profile([{ name: "Kiro", footprint: 63 }, { name: "AWS Lambda", files: ["a.ts", "b.ts", "c.ts", "d.ts"], footprint: 3 }]));
    expect(concepts.map(concept => concept.name)).toEqual(["Kiro", "AWS Lambda"]);
    expect(concepts[0]!.centrality).toBe(6);
  });

  it("compresses a large footprint", () => {
    expect(centralities(profile([{ name: "Kiro", footprint: 1023 }, { name: "AWS Lambda", footprint: 1 }]))).toEqual({ Kiro: 10, "AWS Lambda": 1 });
  });

  it("halves a supporting service after the log", () => {
    expect(centralities(profile([{ name: "Amazon SQS", role: "supporting", footprint: 15 }]))["Amazon SQS"]).toBe(2);
  });

  it("takes the largest footprint among the spellings of one service, and of a service and its pattern twin", () => {
    const c = centralities(profile(
      [{ name: "lambda", catalogName: "AWS Lambda", footprint: 3 }, { name: "AWS Lambda", footprint: 15 }, { name: "Amazon ECS", catalogName: "Amazon Elastic Container Service (Amazon ECS)", footprint: 1 }],
      [{ name: "ecs", footprint: 7 }],
    ));
    expect(c["AWS Lambda"]).toBe(4);
    expect(c["Amazon Elastic Container Service (Amazon ECS)"]).toBe(3);
  });

  it("orders concepts by the footprint centrality", () => {
    const { concepts } = buildConcepts(profile([{ name: "AWS Lambda", footprint: 40 }, { name: "Amazon DynamoDB", footprint: 2 }], [{ name: "event-driven", footprint: 9 }]));
    expect(concepts.map(concept => concept.name)).toEqual(["AWS Lambda", "event-driven", "Amazon DynamoDB"]);
  });
});
