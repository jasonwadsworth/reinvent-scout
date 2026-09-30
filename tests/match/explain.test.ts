import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildConcepts, matchConcepts } from "../../src/match/explain.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const cite = (file: string, line = 1, repo = "repo") => ({ repo, file, line });
const profile = (
  services: Array<{ name: string; catalogName?: string | null; role?: "core" | "supporting"; files?: string[] }>,
  patterns: Array<{ name: string; files?: string[] }> = [],
): ResolvedProfile => ({
  schemaVersion: 1,
  repos: [{ root: "repo", languages: [] }],
  services: services.map(service => ({
    name: service.name,
    catalogName: service.catalogName === undefined ? service.name : service.catalogName,
    ...(service.role === undefined ? {} : { role: service.role }),
    evidence: (service.files ?? ["a.ts"]).map(file => cite(file)),
  })),
  patterns: patterns.map(pattern => ({ name: pattern.name, evidence: (pattern.files ?? ["a.ts"]).map(file => cite(file)) })),
  unresolvedServices: [],
});
const record = (session: Partial<Session> & { title: string }) =>
  buildIndexRecord({ sessionId: session.abbreviation ?? "s1", level: "200 - Intermediate", ...session });

describe("buildConcepts", () => {
  it("takes core services and non-gap patterns, and drops platform services, gaps and dead code", () => {
    const { concepts, uncovered } = buildConcepts(profile(
      [{ name: "AWS Lambda" }, { name: "Amazon CloudWatch" }, { name: "Amazon Simple Storage Service (Amazon S3)" }],
      [{ name: "serverless" }, { name: "gap-no-dlq" }, { name: "dead-code" }],
    ));
    expect(concepts.map(concept => concept.name).sort()).toEqual(["AWS Lambda", "serverless"]);
    expect(uncovered).toEqual([]);
  });

  it("orders concepts by distinct cited files, not by citation count, and halves a supporting service", () => {
    const { concepts } = buildConcepts(profile(
      [
        { name: "AWS Lambda", files: ["a.ts", "b.ts", "c.ts"] },
        { name: "Amazon DynamoDB", files: ["a.ts", "a.ts", "a.ts", "a.ts"] },
        { name: "Amazon SQS", catalogName: "Amazon Simple Queue Service (Amazon SQS)", role: "supporting", files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
      ],
      [{ name: "event-driven", files: ["a.ts", "b.ts"] }],
    ));
    expect(concepts.map(concept => [concept.name, concept.centrality])).toEqual([
      ["AWS Lambda", 3], ["event-driven", 2], ["Amazon Simple Queue Service (Amazon SQS)", 2], ["Amazon DynamoDB", 1],
    ]);
  });

  it("counts a file cited in two repos as two", () => {
    const multi = profile([{ name: "AWS Lambda" }]);
    multi.services[0]!.evidence = [cite("a.ts", 1, "one"), cite("a.ts", 9, "two"), cite("a.ts", 12, "two")];
    expect(buildConcepts(multi).concepts[0]!.centrality).toBe(2);
  });

  it("keeps the evidence citations of the concept", () => {
    const { concepts } = buildConcepts(profile([{ name: "AWS Lambda", files: ["src/h.ts"] }]));
    expect(concepts[0]!.citations).toEqual([cite("src/h.ts")]);
  });

  it("counts a service resolved from two spellings once, with both spellings' citations", () => {
    const { concepts } = buildConcepts(profile([
      { name: "lambda", catalogName: "AWS Lambda", files: ["a.ts"] },
      { name: "AWS Lambda", catalogName: "AWS Lambda", files: ["b.ts"] },
    ]));
    expect(concepts).toHaveLength(1);
    expect(concepts[0]!.centrality).toBe(2);
  });

  it("reports a pattern with no phrase entry as uncovered, and keeps the ones that have one", () => {
    const { concepts, uncovered } = buildConcepts(profile([], [{ name: "serverless" }, { name: "mcp-server" }, { name: "Event-Driven" }]));
    expect(concepts.map(concept => concept.name)).toEqual(["Event-Driven", "serverless"]);
    expect(uncovered).toEqual([{ concept: "mcp-server", reason: "no session phrase is defined for this pattern, so no session can be matched to it" }]);
  });

  it("keeps a service the catalog has no name for, matched by the profile's own spelling", () => {
    const { concepts } = buildConcepts(profile([{ name: "Playwright", catalogName: null }]));
    expect(concepts.map(concept => concept.name)).toEqual(["Playwright"]);
  });
});

describe("matchConcepts", () => {
  const lambda = buildConcepts(profile([{ name: "AWS Lambda" }])).concepts;
  const dynamo = buildConcepts(profile([{ name: "Amazon DynamoDB" }])).concepts;
  const serverless = buildConcepts(profile([], [{ name: "serverless" }])).concepts;
  const strengths = (concepts: ReturnType<typeof buildConcepts>["concepts"], session: Parameters<typeof record>[0], abstract = "") =>
    matchConcepts(concepts, record(session), abstract).map(match => [match.concept.name, match.strength, match.phrase]);

  it("admits a session that names the concept in its title, by its short name", () => {
    expect(strengths(dynamo, { title: "Getting started with DynamoDB" })).toEqual([["Amazon DynamoDB", 3, "DynamoDB"]]);
  });

  it("admits a session that names the concept twice in its abstract, and not once", () => {
    const title = { title: "Building data-driven apps" };
    expect(strengths(dynamo, title, "You will use DynamoDB for storage.")).toEqual([]);
    expect(strengths(dynamo, title, "You will use DynamoDB for storage. DynamoDB scales.")).toEqual([["Amazon DynamoDB", 2, "DynamoDB"]]);
  });

  it("counts a full name and the short form inside it as one mention", () => {
    expect(strengths(dynamo, { title: "Data at scale" }, "Learn Amazon DynamoDB.")).toEqual([]);
  });

  it("never admits on a listed service or a tag alone", () => {
    const tagged = { title: "Building data-driven apps", services: ["Amazon DynamoDB"], topics: ["Serverless"] };
    expect(strengths(dynamo, tagged)).toEqual([]);
    expect(strengths(serverless, tagged)).toEqual([]);
  });

  it("does not count a mention inside an enumeration of names", () => {
    const abstract = "It covers Amazon S3, DynamoDB, and Amazon SQS. Also Kinesis, DynamoDB or Amazon RDS.";
    expect(strengths(dynamo, { title: "Storage options" }, abstract)).toEqual([]);
    expect(strengths(dynamo, { title: "DynamoDB, Amazon S3, and Amazon RDS" })).toEqual([]);
  });

  it("does not count a lowercase concept list as prose either", () => {
    expect(strengths(serverless, { title: "Modern apps" }, "Serverless, containers, and event-driven design. Also serverless, edge, and containers.")).toEqual([]);
  });

  it("matches a pattern by its curated phrase", () => {
    expect(strengths(serverless, { title: "Going serverless" })).toEqual([["serverless", 3, "serverless"]]);
    const eventDriven = buildConcepts(profile([], [{ name: "event-driven" }])).concepts;
    expect(strengths(eventDriven, { title: "Building your first event driven application" })).toEqual([["event-driven", 3, "event driven"]]);
  });

  it("does not read the word lambda as the service", () => {
    expect(strengths(lambda, { title: "Functional programming" }, "A lambda is a function. Every lambda is small.")).toEqual([]);
  });

  it("marks a match boosted when the session also lists the service or carries a matching topic", () => {
    const listed = matchConcepts(dynamo, record({ title: "DynamoDB basics", services: ["Amazon DynamoDB"] }), "");
    const plain = matchConcepts(dynamo, record({ title: "DynamoDB basics" }), "");
    expect(listed[0]!.boosted).toBe(true);
    expect(plain[0]!.boosted).toBe(false);
    const tagged = matchConcepts(serverless, record({ title: "Going serverless", topics: ["Serverless"] }), "");
    expect(tagged[0]!.boosted).toBe(true);
  });
});
