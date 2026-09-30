import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildConcepts, explainReason, matchConcepts, selectExplain, type ExplainSession } from "../../src/match/explain.js";
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

  it("merges the ecs and eks patterns into the service of the same name, with both citations and Kubernetes wording", () => {
    const { concepts } = buildConcepts(profile(
      [{ name: "Amazon ECS", catalogName: "Amazon Elastic Container Service (Amazon ECS)", files: ["a.ts"] }, { name: "Amazon EKS", catalogName: "Amazon Elastic Kubernetes Service (Amazon EKS)", files: ["b.ts"] }],
      [{ name: "ecs", files: ["c.ts"] }, { name: "eks", files: ["d.ts"] }, { name: "containers", files: ["e.ts"] }],
    ));
    expect(concepts.map(concept => [concept.name, concept.centrality]).sort()).toEqual([
      ["Amazon Elastic Container Service (Amazon ECS)", 2], ["Amazon Elastic Kubernetes Service (Amazon EKS)", 2], ["containers", 1],
    ]);
    const eks = concepts.find(concept => concept.name.includes("Kubernetes"))!;
    expect(matchConcepts([eks], record({ title: "Kubernetes from scratch" }), "")).toHaveLength(1);
  });

  it("keeps the ecs pattern when the profile lists no ECS service", () => {
    expect(buildConcepts(profile([], [{ name: "ecs" }])).concepts.map(concept => concept.name)).toEqual(["ecs"]);
  });

  it("puts a pattern ahead of a service at the same centrality", () => {
    const { concepts } = buildConcepts(profile([{ name: "Amazon DynamoDB" }, { name: "AWS Lambda" }], [{ name: "serverless" }]));
    expect(concepts.map(concept => concept.name)).toEqual(["serverless", "Amazon DynamoDB", "AWS Lambda"]);
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
    expect(uncovered).toEqual([{ concept: "mcp-server", kind: "pattern", reason: "no session phrase is defined for this pattern, so no session can be matched to it" }]);
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

  it("admits a session that names the concept twice in its abstract and corroborates it, and not once", () => {
    const title = { title: "Building data-driven apps", services: ["Amazon DynamoDB"] };
    expect(strengths(dynamo, title, "You will use DynamoDB for storage.")).toEqual([]);
    expect(strengths(dynamo, title, "You will use DynamoDB for storage. DynamoDB scales.")).toEqual([["Amazon DynamoDB", 2, "DynamoDB"]]);
  });

  it("does not admit on an abstract alone that no service or tag corroborates", () => {
    expect(strengths(dynamo, { title: "Building data-driven apps" }, "You will use DynamoDB for storage. DynamoDB scales.")).toEqual([]);
  });

  it("counts a full name and the short form inside it as one mention", () => {
    expect(strengths(dynamo, { title: "Data at scale", services: ["Amazon DynamoDB"] }, "Learn Amazon DynamoDB.")).toEqual([]);
  });

  it("never admits on a listed service or a tag alone", () => {
    const tagged = { title: "Building data-driven apps", services: ["Amazon DynamoDB"], topics: ["Serverless"] };
    expect(strengths(dynamo, tagged)).toEqual([]);
    expect(strengths(serverless, tagged)).toEqual([]);
  });

  it("does not count a mention inside an enumeration of names", () => {
    const abstract = "It covers Amazon S3, DynamoDB, and Amazon SQS. Also Kinesis, DynamoDB or Amazon RDS.";
    expect(strengths(dynamo, { title: "Storage options", services: ["Amazon DynamoDB"] }, abstract)).toEqual([]);
    expect(strengths(dynamo, { title: "DynamoDB, Amazon S3, and Amazon RDS" })).toEqual([]);
  });

  it("reads an ampersand as an and in an enumeration", () => {
    expect(strengths(dynamo, { title: "Lambda, DynamoDB & SQS scaling lessons" })).toEqual([]);
  });

  it("does not count a lowercase concept list as prose either", () => {
    expect(strengths(serverless, { title: "Modern apps" }, "Serverless, containers, and event-driven design. Also serverless, edge, and containers.")).toEqual([]);
  });

  it("matches a pattern by its curated phrase", () => {
    expect(strengths(serverless, { title: "Going serverless" })).toEqual([["serverless", 3, "serverless"]]);
    const eventDriven = buildConcepts(profile([], [{ name: "event-driven" }])).concepts;
    expect(strengths(eventDriven, { title: "Building your first event driven application" })).toEqual([["event-driven", 3, "event driven"]]);
  });

  it.each([
    ["serverless", "Going serverless with functions"],
    ["event-driven", "Designing event-driven systems"],
    ["api", "Designing REST APIs at scale"],
    ["api", "API Gateway unleashed"],
    ["multi-tenant", "Multi-tenant SaaS architecture"],
    ["multi-account", "Multi-account strategy with AWS Organizations"],
    ["iac-cdk", "Infrastructure as code with the AWS CDK"],
    ["containers", "Containers for beginners"],
    ["ecs", "Running workloads on Amazon ECS"],
    ["eks", "Kubernetes on EKS from scratch"],
    ["agentic", "Building agentic applications"],
    ["genai-single-call", "Building your first generative AI application"],
    ["streaming", "Streaming data with Kinesis"],
    ["data-lake", "Building a data lake"],
  ])("has a curated phrase for the %s pattern: %s", (name, title) => {
    const concepts = buildConcepts(profile([], [{ name }])).concepts;
    expect(strengths(concepts, { title }).map(([concept]) => concept)).toEqual([name]);
  });

  it("matches the distinctive last word of a multi-word name, such as AgentCore for Amazon Bedrock AgentCore", () => {
    const agentcore = buildConcepts(profile([{ name: "Amazon Bedrock AgentCore" }])).concepts;
    expect(strengths(agentcore, { title: "Best practices to build agents on AgentCore" })).toEqual([["Amazon Bedrock AgentCore", 3, "AgentCore"]]);
    const queue = buildConcepts(profile([{ name: "Amazon SQS", catalogName: "Amazon Simple Queue Service (Amazon SQS)" }])).concepts;
    expect(strengths(queue, { title: "Service mesh basics" })).toEqual([]);
    expect(strengths(queue, { title: "Queue basics" })).toEqual([]);
  });

  it("matches a name that needs its prefix when the prefix is shared across a coordinated list", () => {
    const transcribe = buildConcepts(profile([{ name: "Amazon Transcribe" }])).concepts;
    expect(strengths(transcribe, { title: "Build voice AI with Amazon Polly and Transcribe" })).toEqual([["Amazon Transcribe", 3, "Amazon Polly and Transcribe"]]);
    expect(strengths(transcribe, { title: "Build voice AI with Amazon Polly, Transcribe" })).toHaveLength(1);
    expect(strengths(transcribe, { title: "Please transcribe this and Transcribe that" })).toEqual([]);
  });

  it("does not read the word lambda as the service", () => {
    expect(strengths(lambda, { title: "Functional programming" }, "A lambda is a function. Every lambda is small.")).toEqual([]);
  });

  it("never explains from a sponsored session, which is the sponsor's pitch", () => {
    expect(strengths(dynamo, { title: "DynamoDB at scale (sponsored by Acme)" })).toEqual([]);
    expect(strengths(dynamo, { title: "Data at scale (sponsored by Acme)" }, "DynamoDB here. DynamoDB there.")).toEqual([]);
  });

  it("never explains from a customer story or partner enablement session", () => {
    for (const title of ["How AI-native startups run DynamoDB in production", "Beyond the pilot: How customers scaled DynamoDB", "AWS Partner: Build with DynamoDB"]) {
      expect(strengths(dynamo, { title }), title).toEqual([]);
    }
    for (const title of ["How to model data in DynamoDB", "How DynamoDB works", "DynamoDB: how does it scale?"]) {
      expect(strengths(dynamo, { title }), title).toHaveLength(1);
    }
  });

  it("never explains from a feature-news, modernization or certification session", () => {
    for (const title of [
      "Modernizing your compute stack with DynamoDB's new execution models", "New silicon, new instances, DynamoDB", "DynamoDB launches",
      "Modernize legacy applications with DynamoDB", "Migration strategies for DynamoDB", "DynamoDB transformation roadmap",
      "DynamoDB certification path", "DynamoDB exam prep", "Proficiency in DynamoDB",
    ]) {
      expect(strengths(dynamo, { title }), title).toEqual([]);
    }
    expect(strengths(dynamo, { title: "Renewing DynamoDB tables" })).toHaveLength(1);
  });

  it("never explains from a news or recap session", () => {
    for (const title of ["What's new in DynamoDB", "DynamoDB: a year in review", "The latest DynamoDB announcements", "DynamoDB recap"]) {
      expect(strengths(dynamo, { title }), title).toEqual([]);
    }
    expect(strengths(dynamo, { title: "DynamoDB basics" }, "See what\u2019s new. Learn what's new.")).toEqual([["Amazon DynamoDB", 3, "DynamoDB"]]);
  });

  it("admits a broad pattern such as agentic only when the title names it and says how to build or design", () => {
    const agentic = buildConcepts(profile([], [{ name: "agentic" }])).concepts;
    const abstract = "Agentic systems are new. Build agentic workflows.";
    expect(strengths(agentic, { title: "Building agentic applications" })).toEqual([["agentic", 3, "agentic"]]);
    expect(strengths(agentic, { title: "Best practices to build and optimize agents" })).toEqual([["agentic", 3, "agents"]]);
    expect(strengths(agentic, { title: "Where do agents fit?" })).toEqual([]);
    expect(strengths(agentic, { title: "AWS AI agents accelerate SAP migration" })).toEqual([]);
    expect(strengths(agentic, { title: "Agentic modernization with United Airlines" })).toEqual([]);
    expect(strengths(agentic, { title: "Govern AI agents by hacking one first" })).toEqual([]);
    expect(strengths(agentic, { title: "A guide to agents" })).toEqual([]);
    expect(strengths(agentic, { title: "Data pipelines" }, abstract)).toEqual([]);
    const genai = buildConcepts(profile([], [{ name: "genai-single-call" }])).concepts;
    expect(strengths(genai, { title: "Data pipelines" }, "Generative AI is here. Use generative AI wisely.")).toEqual([]);
    expect(strengths(genai, { title: "Generative AI for insurers" })).toEqual([]);
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

describe("selectExplain", () => {
  const concepts = buildConcepts(profile(
    [{ name: "AWS Lambda", files: ["a.ts", "b.ts", "c.ts"] }, { name: "Amazon DynamoDB", files: ["a.ts", "b.ts"] }],
    [{ name: "serverless", files: ["a.ts"] }],
  )).concepts;
  const session = (code: string, title: string, options: { level?: string; type?: string; abstract?: string; rank?: number; services?: string[] } = {}): ExplainSession => {
    const built = record({
      title, abbreviation: code, level: options.level ?? "200 - Intermediate",
      ...(options.type === undefined ? {} : { type: options.type }),
      ...(options.services === undefined ? {} : { services: options.services }),
    });
    return { key: code, record: built, matches: matchConcepts(concepts, built, options.abstract ?? ""), rank: options.rank ?? 0 };
  };
  const order = (sessions: ExplainSession[]) => selectExplain(sessions, concepts).selected.map(entry => entry.key);

  it("takes the best session per concept each round, in centrality order", () => {
    expect(order([
      session("L1", "Lambda basics"), session("L2", "More Lambda"), session("L3", "Lambda again"),
      session("D1", "DynamoDB basics"), session("S1", "Going serverless"),
    ])).toEqual(["L1", "D1", "S1", "L2", "L3"]);
  });

  it("does not spend a covered concept's first turn on a second session", () => {
    expect(order([
      session("LD", "Lambda and DynamoDB together", { rank: 5 }), session("D2", "DynamoDB deep dive"), session("L2", "Lambda tips"),
    ])).toEqual(["LD", "L2", "D2"]);
  });

  it("lists every concept a session covers, the one it was taken for first", () => {
    const { selected } = selectExplain([session("LD", "Lambda and DynamoDB together")], concepts);
    expect(selected[0]!.matches.map(match => match.concept.name)).toEqual(["AWS Lambda", "Amazon DynamoDB"]);
  });

  it("puts the concept a session was taken for first, ahead of a more central one it also covers", () => {
    const { selected } = selectExplain([
      session("L1", "Lambda basics", { rank: 9 }), session("LD", "Lambda and DynamoDB together"),
    ], concepts);
    expect(selected.map(entry => entry.key)).toEqual(["L1", "LD"]);
    expect(selected[1]!.matches.map(match => match.concept.name)).toEqual(["Amazon DynamoDB", "AWS Lambda"]);
  });

  it("ranks a concept's sessions by title over abstract, then a listed service, then format, then relevance", () => {
    const abstract = "Lambda runs code. Lambda scales.";
    expect(order([
      session("ABS", "Compute talk", { abstract, services: ["AWS Lambda"] }),
      session("TTL", "Lambda talk", { services: ["AWS Lambda"] }),
    ])).toEqual(["TTL", "ABS"]);
    expect(order([
      session("A-PLN", "Lambda plain"), session("Z-LST", "Lambda listed", { services: ["AWS Lambda"] }),
    ])).toEqual(["Z-LST", "A-PLN"]);
    expect(order([
      session("A-WRK", "Lambda workshop", { type: "Workshop" }), session("Z-BRK", "Lambda breakout", { type: "Breakout session" }),
    ])).toEqual(["Z-BRK", "A-WRK"]);
    expect(order([
      session("A-LOW", "Lambda low", { rank: 1 }), session("Z-HIGH", "Lambda high", { rank: 9 }),
    ])).toEqual(["Z-HIGH", "A-LOW"]);
  });

  it("ranks a title match above an abstract match whatever the boost or the introduction cue", () => {
    const abstract = "Lambda runs code. Lambda scales.";
    expect(order([
      session("A-ABS", "Compute talk", { abstract, services: ["AWS Lambda"] }),
      session("Z-TTL", "Lambda talk"),
    ])).toEqual(["Z-TTL", "A-ABS"]);
    expect(order([
      session("A-ABS", "Getting started with compute", { abstract, services: ["AWS Lambda"], type: "Breakout session" }),
      session("Z-TTL", "Lambda talk", { type: "Workshop" }),
    ])).toEqual(["Z-TTL", "A-ABS"]);
  });

  it("does not list a 300-level session, and names the closest one in the uncovered reason", () => {
    const { selected, uncovered } = selectExplain([
      session("D3", "DynamoDB design", { level: "300 - Advanced" }), session("D3B", "DynamoDB modeling", { level: "300 - Advanced" }),
      session("L1", "Lambda basics"),
    ], concepts);
    expect(selected.map(entry => entry.key)).toEqual(["L1"]);
    expect(uncovered[0]).toEqual({ concept: "Amazon DynamoDB", kind: "service", reason: 'no introductory (100/200) session is about it; the closest is a 300-level one: D3 "DynamoDB design"' });
  });

  it("prefers a title that reads as an introduction, after strength and boost", () => {
    expect(order([
      session("A-PLN", "Lambda in the enterprise"), session("Z-INT", "Lambda getting started"),
    ])).toEqual(["Z-INT", "A-PLN"]);
    expect(order([
      session("A-INT", "Lambda getting started"), session("Z-LST", "Lambda plain", { services: ["AWS Lambda"] }),
    ])).toEqual(["Z-LST", "A-INT"]);
  });

  it("names a 300 session in the uncovered reason only when its title names the concept", () => {
    const { selected, uncovered } = selectExplain([
      session("D3", "Modeling data", { level: "300 - Advanced", abstract: "DynamoDB tables. DynamoDB keys.", services: ["Amazon DynamoDB"] }),
    ], concepts);
    expect(selected).toEqual([]);
    expect(uncovered.find(entry => entry.concept === "Amazon DynamoDB")!.reason).toBe("no introductory (100/200) or 300-level session is about it");
  });

  it("does not take a 300 session for a concept an introductory session covers", () => {
    expect(order([session("L1", "Lambda basics"), session("L3", "Lambda internals", { level: "300 - Advanced" })])).toEqual(["L1"]);
  });

  it("ignores sessions with no level band and 400 level sessions", () => {
    expect(order([session("L4", "Lambda expert", { level: "400 - Expert" }), session("L0", "Lambda unknown", { level: "" })])).toEqual([]);
    const { uncovered } = selectExplain([session("L4", "Lambda expert", { level: "400 - Expert" })], concepts);
    expect(uncovered[0]!.reason).toBe("no introductory (100/200) or 300-level session is about it");
  });

  it("reports a concept with no qualifying session as uncovered, in centrality order", () => {
    const { uncovered } = selectExplain([session("L1", "Lambda basics")], concepts);
    expect(uncovered).toEqual([
      { concept: "Amazon DynamoDB", kind: "service", reason: "no introductory (100/200) or 300-level session is about it" },
      { concept: "serverless", kind: "pattern", reason: "no introductory (100/200) or 300-level session is about it" },
    ]);
  });

});

describe("explainReason", () => {
  const withEvidence = (citations: Array<{ repo: string; file: string; line?: number }>) => {
    const built = profile([{ name: "Amazon DynamoDB" }]);
    built.services[0]!.evidence = citations;
    return buildConcepts(built).concepts;
  };
  const reasonFor = (concepts: ReturnType<typeof buildConcepts>["concepts"], session: Parameters<typeof record>[0] = { title: "DynamoDB basics" }) => {
    const [match] = matchConcepts(concepts, record(session), "");
    return explainReason(match!, 1);
  };

  it("names the concept, the code that uses it and the session phrase", () => {
    const reason = reasonFor(withEvidence([{ repo: "repo", file: "src/db/table.ts", line: 14 }]));
    expect(reason.kind).toBe("explainsConcept");
    expect(reason.detail).toBe('Explains Amazon DynamoDB ("DynamoDB"), which this code uses at src/db/table.ts:14.');
    expect(reason.evidence).toBe("DynamoDB");
    expect(reason.profileEvidence).toEqual([{ repo: "repo", file: "src/db/table.ts", line: 14 }]);
  });

  it("lists at most three citations and counts the rest, each place once", () => {
    const reason = reasonFor(withEvidence([
      { repo: "repo", file: "a.ts", line: 1 }, { repo: "repo", file: "a.ts", line: 1 }, { repo: "repo", file: "b.ts" },
      { repo: "repo", file: "c.ts", line: 3 }, { repo: "repo", file: "d.ts", line: 4 }, { repo: "repo", file: "e.ts", line: 5 },
    ]));
    expect(reason.detail).toContain("which this code uses at a.ts:1, b.ts, c.ts:3 and 2 more");
    expect(reason.profileEvidence).toHaveLength(5);
  });

  it("prefixes the repo when the profile has several", () => {
    const [match] = matchConcepts(withEvidence([{ repo: "api", file: "a.ts", line: 1 }]), record({ title: "DynamoDB basics" }), "");
    expect(explainReason(match!, 2).detail).toContain("at api/a.ts:1");
  });

  it("weighs a title hit above an abstract hit and a boost above neither", () => {
    const concepts = withEvidence([{ repo: "repo", file: "a.ts" }]);
    const title = reasonFor(concepts).weight;
    const listed = reasonFor(concepts, { title: "DynamoDB basics", services: ["Amazon DynamoDB"] }).weight;
    const [abstractOnly] = matchConcepts(concepts, record({ title: "Data", services: ["Amazon DynamoDB"] }), "DynamoDB here. DynamoDB there.");
    expect(listed).toBeGreaterThan(title);
    expect(explainReason(abstractOnly!, 1).weight).toBeLessThan(listed);
    expect(explainReason({ ...abstractOnly!, boosted: false }, 1).weight).toBeLessThan(title);
  });
});
