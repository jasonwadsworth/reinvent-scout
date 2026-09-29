import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStackFit } from "../../src/match/stack-fit.js";
import { LENS_RULE_SELECTORS, scoreLensSignals, skippedLensRules } from "../../src/match/lens-signals.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const citation = { repo: "checkout", file: "infra/stack.ts", line: 42, snippet: "new Queue(stack)", note: "Inspected this deployment scope." };
const profile = (...names: string[]): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "checkout", languages: [] }], services: [],
  patterns: names.map(name => ({ name, evidence: [citation] })), unresolvedServices: [],
});
const record = (title: string) => buildIndexRecord({ sessionId: "test", title });
const gaps = [
  ["gap-no-dlq", "Reliability", "Dead-letter queues and redrive", "Queue messaging with Amazon SQS"],
  ["gap-no-alarms", "Operational Excellence", "CloudWatch alarms and alerting strategy", "Operational best practices"],
  ["gap-no-tests", "Operational Excellence", "Automated testing strategies", "Application development with latest tools"],
  ["gap-broad-iam", "Security", "Least privilege IAM policies", "Security best practices"],
  ["gap-no-load-tests", "Performance Efficiency", "Load testing distributed applications", "High performance compute"],
  ["gap-no-cost-monitoring", "Cost Optimization", "Cost monitoring and cost allocation", "Save money on cloud costs"],
  ["gap-no-resource-rightsizing", "Sustainability", "Resource rightsizing", "Sustainable resources for the future"],
] as const;

describe("gap-no-alarms phrase", () => {
  const score = (title: string, abstract = "") => scoreLensSignals(record(title), profile("gap-no-alarms"), "fix", abstract).score;
  it.each([
    "CloudWatch alarms in practice", "Alarms on queue depth", "Alarm for error rate", "Building an alerting strategy",
    "On-call alerts that work", "Paging alerts for the right person", "Alarms that page the on-call engineer", "SLO alerting at scale", "SLI and alerting design",
  ])("matches operational alarm or alerting language: %s", title => expect(score(title)).toBe(50));
  it.each([
    "Bare alerts and alarms", "Handling alerts", "Intelligent alerts", "Alarms", "Anomaly detection with alerts",
    "Telecom network alarms", "Alerting", "A dashboard of alarms",
    "AI on-call agents that resolve incidents", "Paging through large result sets", "On-call", "Paging",
  ])("does not match bare alerts or alarms: %s", title => expect(score(title, `${title}. Again: ${title}.`)).toBe(0));
});

describe("gap-no-cost-monitoring phrase", () => {
  const score = (title: string, abstract = "") => scoreLensSignals(record(title), profile("gap-no-cost-monitoring"), "fix", abstract).score;
  it.each(["Cost-allocation tags at scale", "Cost allocation for teams", "AWS Budgets in practice", "Cost budgets that work", "Setting budgets for cost control"])("matches %s", title => {
    expect(score(title)).toBe(50);
  });
  it.each(["Budgets", "Budget your time", "Team budgets and plans"])("does not match %s", title => {
    expect(score(title, `${title}. ${title}.`)).toBe(0);
  });
});

describe("list detector counts names, not concept words", () => {
  const fix = (name: string, title: string) => scoreLensSignals(record(title), profile(name), "fix").score;
  it("keeps the Fix phrase in a title that lists plain concepts", () => {
    expect(fix("gap-no-dlq", "DLQs, retries, and idempotency")).toBe(50);
    expect(fix("gap-broad-iam", "Least-privilege, encryption, and auditing")).toBe(50);
    expect(fix("gap-no-tests", "Unit tests, mocks, and fixtures")).toBe(50);
  });
  it("still treats a list of capitalized names as a listing", () => {
    expect(fix("gap-no-dlq", "Lambda, SQS, DLQs and EventBridge")).toBe(0);
  });
});

describe("Fix phrases and gap cue", () => {
  const weight = (name: string, title: string, abstract = "") => scoreLensSignals(record(title), profile(name), "fix", abstract).reasons[0]?.weight;
  it("does not read a bare no as a gap cue", () => {
    expect(weight("gap-no-dlq", "Deep dive", "In ways no dead-letter queues or dead-letter queues can catch.")).toBe(40);
    expect(weight("gap-no-tests", "Deep dive", "There is no exception, no unit testing, and no unit tests.")).toBe(40);
    expect(weight("gap-no-tests", "Deep dive", "We were missing unit tests.")).toBe(40);
    expect(weight("gap-no-tests", "Deep dive", "We were missing unit tests. Also, without integration tests.")).toBe(50);
    expect(weight("gap-broad-iam", "Deep dive", "In ways no IAM policy catches.")).toBeUndefined();
  });
  it("admits a DLQ mentioned once only when the abstract calls it missing or the title names it", () => {
    expect(weight("gap-no-dlq", "Deep dive", "One scenario is SQS dead-letter queue buildup.")).toBeUndefined();
    expect(weight("gap-no-dlq", "Deep dive", "Anti-patterns such as missing dead-letter queues.")).toBe(40);
    expect(weight("gap-no-dlq", "Dead-letter queues")).toBe(50);
  });
  it.each(["Test-driven infrastructure", "Raising test coverage", "Testing infrastructure as code"])("matches %s for gap-no-tests", title => {
    expect(weight("gap-no-tests", title)).toBe(50);
  });
});

describe("Fix signals", () => {
  it.each(gaps)("maps %s to scoped guidance in %s", (name, pillar, title) => {
    const result = scoreLensSignals(record(title), profile(name), "fix");
    expect(result.score).toBe(50);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatchObject({ kind: "pillarGap", weight: 50, profileEvidence: [citation] });
    expect(result.reasons[0]!.detail).toContain(name);
    expect(result.reasons[0]!.detail).toContain(pillar);
    expect(result.reasons[0]!.detail).toContain(name === "gap-broad-iam" ? "scope concern" : "not evident in the cited scope");
    expect(title.toLowerCase()).toContain(result.reasons[0]!.evidence.toLowerCase());
  });
  it.each(gaps)("rejects broad subject overlap for %s", (name, _pillar, _title, broadTitle) => {
    expect(scoreLensSignals(record(broadTitle), profile(name), "fix")).toEqual({ score: 0, reasons: [], hits: [] });
  });
  it.each(["gap-no-dlq-extra", "gap-unrecognized", "constructor", "toString", ""])("rejects unsupported exact source %s even for a remediation session", name => {
    expect(scoreLensSignals(record("Dead-letter queues"), profile(name), "fix").score).toBe(0);
  });
  it("merges duplicate patterns and citations without inflating rule weight", () => {
    const p = profile("gap-no-dlq", "GAP-NO-DLQ");
    p.patterns[1]!.evidence.push({ ...citation, file: "other.ts" });
    // Different property order must not turn the same citation into a second source.
    p.patterns[1]!.evidence.push({ line: 42, file: "infra/stack.ts", repo: "checkout", note: citation.note, snippet: citation.snippet });
    const result = scoreLensSignals(record("Dead-letter queues and redrive"), p, "fix");
    expect(result.score).toBe(50);
    expect(result.reasons[0]!.profileEvidence).toEqual([citation, { ...citation, file: "other.ts" }]);
  });
  it("adds distinct rules with their own sources", () => {
    const result = scoreLensSignals(record("CloudWatch alarms and dead-letter queues"), profile("gap-no-dlq", "gap-no-alarms"), "fix");
    expect(result.reasons).toHaveLength(2);
    expect(result.score).toBe(100);
    expect(result.score).toBe(result.reasons.reduce((sum, reason) => sum + reason.weight, 0));
  });
  it("uses contiguous whole phrases from abstract text, not bag-of-words overlap", () => {
    const r = record("Queue operations");
    expect(scoreLensSignals(r, profile("gap-no-dlq"), "fix", "Learn about missing Dead-Letter queues.").reasons[0]?.evidence).toBe("Dead-Letter queues");
    expect(scoreLensSignals(r, profile("gap-no-load-tests"), "fix", "Balance load while testing unrelated features.").score).toBe(0);
    expect(scoreLensSignals(record("Download testing tools"), profile("gap-no-load-tests"), "fix").score).toBe(0);
    expect(scoreLensSignals(record("An alarming tale"), profile("gap-no-alarms"), "fix").score).toBe(0);
  });
  it("never admits on a tag, topic or service alone", () => {
    const tagged = (name: string, extra: object) => scoreLensSignals(buildIndexRecord({ sessionId: "x", title: "Deep dive", ...extra }), profile(name), name.startsWith("gap") ? "fix" : "next-level").score;
    expect(tagged("gap-no-alarms", { areasOfInterest: ["Monitoring & Observability"] })).toBe(0);
    expect(tagged("gap-broad-iam", { topics: ["Security & Identity"], services: ["AWS Identity and Access Management (IAM)"] })).toBe(0);
    expect(tagged("serverless", { topics: ["Containers"], services: ["Amazon Elastic Container Service (Amazon ECS)"] })).toBe(0);
    expect(tagged("ecs", { areasOfInterest: ["Kubernetes"], services: ["Amazon Elastic Kubernetes Service (Amazon EKS)"] })).toBe(0);
    expect(tagged("genai-single-call", { areasOfInterest: ["Agentic AI"] })).toBe(0);
  });
  it("grades signal strength from the session's own text: title 3, abstract twice 2, once 1", () => {
    const strengthOf = (title: string, abstract: string, name = "gap-no-tests") => scoreLensSignals(record(title), profile(name), "fix", abstract).reasons[0]?.weight;
    expect(strengthOf("Unit testing", "")).toBe(50);
    expect(strengthOf("Deep dive", "We cover unit tests and integration testing.")).toBe(40);
    expect(strengthOf("Deep dive", "Only one mention of unit tests here.")).toBeUndefined();
    expect(strengthOf("Deep dive", "Mentions dead-letter queues twice: dead-letter queues.", "gap-no-dlq")).toBe(40);
  });
  it("adds one strength when the abstract describes the phrase as missing", () => {
    const weight = (abstract: string) => scoreLensSignals(record("Deep dive"), profile("gap-no-dlq"), "fix", abstract).reasons[0]?.weight;
    expect(weight("Anti-patterns such as missing dead-letter queues.")).toBe(40);
    expect(weight("Systems without any dead-letter queues fail.")).toBe(40);
    expect(weight("Anti-patterns include dead-letter queues and dead-letter queues.")).toBe(40);
    expect(weight("Anti-patterns include lacking dead-letter queues.")).toBe(40);
    expect(weight("Anti-patterns include absent DLQs.")).toBe(40);
    expect(weight("We had no idea about many other things, then dead-letter queues.")).toBeUndefined();
    expect(weight("Teams that no longer need dead-letter queues can skip this.")).toBeUndefined();
    expect(weight("Anti-patterns include no dead-letter queues.")).toBeUndefined();
  });
  it("never lets the Monitoring tag lift one weak alarm mention to admission", () => {
    const tagged = (abstract: string) => scoreLensSignals(buildIndexRecord({ sessionId: "x", title: "Deep dive", areasOfInterest: ["Monitoring & Observability"] }), profile("gap-no-alarms"), "fix", abstract).score;
    expect(tagged("Set up a CloudWatch alarm for the queue.")).toBe(0);
    expect(tagged("Set up a CloudWatch alarm for the queue, then another CloudWatch alarm.")).toBe(40);
  });
  it("does not treat the bare word observability as an alarms signal", () => {
    expect(scoreLensSignals(record("Observability deep dive"), profile("gap-no-alarms"), "fix", "Observability and observability again.").score).toBe(0);
    expect(scoreLensSignals(record("Alerting strategy deep dive"), profile("gap-no-alarms"), "fix").score).toBe(50);
  });
  it("reports which rule admitted the session and at what strength", () => {
    const result = scoreLensSignals(record("CloudWatch alarms and dead-letter queues"), profile("gap-no-dlq", "gap-no-alarms"), "fix");
    expect(result.hits).toEqual([{ rule: "gap-no-dlq", strength: 3 }, { rule: "gap-no-alarms", strength: 3 }]);
  });
});

const paths = [
  ["serverless", "Containers", "containers", "runtime control", "operational ownership"],
  ["ecs", "Kubernetes", "EKS", "portability", "complexity"],
  ["genai-single-call", "Agentic workflows", "agentic", "multi-step tool use", "latency"],
] as const;

const onSource: Record<string, string> = { serverless: "Runs on Lambda today.", ecs: "Runs on ECS today.", "genai-single-call": "Starts from a basic prompt today." };

describe("Next-level signals", () => {
  it.each(paths)("offers %s to %s with gains and costs", (source, title, destination, gain, cost) => {
    const result = scoreLensSignals(record(title), profile(source), "next-level", onSource[source]);
    expect(result.score).toBe(50);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatchObject({ kind: "migrationPath", weight: 50, profileEvidence: [citation] });
    const reason = result.reasons[0]!;
    for (const phrase of [source, destination, gain, cost, "option"]) expect(reason.detail).toContain(phrase);
    expect(title.toLowerCase()).toContain(reason.evidence.toLowerCase());
  });
  it.each(paths)("requires exact evidence-bearing source %s", (source, title) => {
    for (const nearName of [`${source}-extra`, "constructor", "single-llm-call"]) {
      expect(scoreLensSignals(record(title), profile(nearName), "next-level").score).toBe(0);
    }
    const p = profile();
    p.services = [{ name: "bedrock", catalogName: "Amazon Bedrock", evidence: [citation] }];
    p.intents = [{ kind: "goal", text: `Migrate ${source} to ${title}` }];
    p.interests = [title];
    expect(scoreLensSignals(record(title), p, "next-level").score).toBe(0);
  });
  it.each(paths)("rejects source-only and alien sessions for %s", (source) => {
    const r = buildIndexRecord({ sessionId: "x", title: `${source} basics`, services: ["AWS Lambda", "Amazon Bedrock"] });
    expect(scoreLensSignals(r, profile(source), "next-level").score).toBe(0);
    expect(scoreLensSignals(record("constructor flibbertigibbet"), profile(source), "next-level").score).toBe(0);
  });
  it("uses destination services and areas only as boosters on a text hit", () => {
    const r = buildIndexRecord({ sessionId: "x", title: "Deep dive", services: ["Amazon Elastic Kubernetes Service (Amazon EKS)"], areasOfInterest: ["Kubernetes"] });
    expect(scoreLensSignals(r, profile("ecs"), "next-level", "Run ECS on Kubernetes.").reasons[0]?.weight).toBe(40);
    expect(scoreLensSignals(r, profile("ecs"), "next-level", "Run it on Kubernetes.").score).toBe(0);
    expect(scoreLensSignals(r, profile("ecs"), "next-level").score).toBe(0);
  });
  const reverseCases = [
    ["serverless", "Lambda: replacing always-on containers with MicroVMs as per-tenant sandboxes; containers cost more."],
    ["serverless", "Lambda MicroVMs run containers and containers."],
    ["serverless", "We migrate containers to Lambda functions, containers included."],
    ["ecs", "Move from Amazon EKS clusters to Amazon ECS; Kubernetes and Kubernetes again."],
  ] as const;
  it.each(reverseCases)("excludes a reverse-direction %s session: %s", (source, abstract) => {
    expect(scoreLensSignals(record("Compute deep dive"), profile(source), "next-level", abstract).score).toBe(0);
  });
  it.each([
    "Runs on Lambda today. Starting from Amazon EKS and EKS clusters, migrate the agents to AgentCore's serverless runtime.",
    "Runs on Lambda today. EKS and containers are the start; then move each tenant onto serverless AgentCore.",
    "Runs on Lambda today. Refactor EKS services and ECS services into Lambda functions.",
  ])("excludes a Kubernetes-to-serverless move: %s", abstract => {
    expect(scoreLensSignals(record("Deep dive"), profile("serverless"), "next-level", abstract).score).toBe(0);
    expect(scoreLensSignals(record("Move your agents to serverless AgentCore"), profile("serverless"), "next-level", "Runs on Lambda today. EKS and containers.").score).toBe(0);
  });
  it("still admits containers as the destination of a move", () => {
    expect(scoreLensSignals(record("Deep dive"), profile("serverless"), "next-level", "Runs on Lambda today. We moved agents off Lambda onto ECS Fargate, with containers and EKS.").score).toBe(40);
    expect(scoreLensSignals(record("Deep dive"), profile("serverless"), "next-level", "Runs on Lambda today. Compare containers and EKS.").score).toBe(40);
  });
  it("excludes a reverse-direction title as well", () => {
    expect(scoreLensSignals(record("Lambda MicroVMs for containers"), profile("serverless"), "next-level").score).toBe(0);
  });
  it("skips a path whose destination pattern the profile already has, case-insensitively", () => {
    for (const [source, destination] of [["serverless", "Containers"], ["ecs", "EKS"], ["genai-single-call", "AGENTIC"]] as const) {
      const title = source === "serverless" ? "Containers" : source === "ecs" ? "Kubernetes" : "Agentic workflows";
      expect(scoreLensSignals(record(title), profile(source), "next-level", onSource[source]).score).toBe(50);
      expect(scoreLensSignals(record(title), profile(source, destination), "next-level", onSource[source]).score).toBe(0);
    }
  });
  it("lists skipped paths with the reason", () => {
    expect(skippedLensRules(profile("genai-single-call", "agentic", "serverless"), "next-level")).toEqual([
      { rule: "genai-single-call", reason: "profile already has agentic" },
    ]);
    expect(skippedLensRules(profile("genai-single-call", "agentic"), "fix")).toEqual([]);
    expect(skippedLensRules(profile("agentic"), "next-level")).toEqual([]);
  });
  it("handles prototype vocabulary safely on both sides after JSON parsing", () => {
    const r = JSON.parse(JSON.stringify(buildIndexRecord({ sessionId: "constructor", title: "constructor", services: ["constructor"], areasOfInterest: ["constructor"], topics: ["constructor"] })));
    expect(scoreLensSignals(r, profile("constructor"), "next-level")).toEqual({ score: 0, reasons: [], hits: [] });
    expect(scoreLensSignals(r, profile("serverless"), "next-level")).toEqual({ score: 0, reasons: [], hits: [] });
  });
});

describe("rule selectors", () => {
  const vocabulary = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "catalog-vocabulary.json"), "utf8")) as Record<"services" | "topics" | "areasOfInterest", string[]>;
  it("names only tags, topics and services that exist in the real catalog vocabulary", () => {
    expect(LENS_RULE_SELECTORS.some(rule => rule.areas.length > 0)).toBe(true);
    for (const rule of LENS_RULE_SELECTORS) {
      for (const [values, known] of [[rule.services, vocabulary.services], [rule.topics, vocabulary.topics], [rule.areas, vocabulary.areasOfInterest]] as const) {
        for (const value of values) expect(known, `${rule.source}: ${value}`).toContain(value);
      }
    }
  });
});

describe("Next-level source co-mention", () => {
  const sourceMention = [
    ["serverless", "Containers", "Runs on Lambda today.", "Runs on serverless today.", "Split into functions today.", "Amazon Elastic Container Service (Amazon ECS)", "AWS Lambda"],
    ["ecs", "Kubernetes", "Migrate from ECS.", "Started on Amazon ECS.", "Our ECS clusters.", "Amazon Elastic Kubernetes Service (Amazon EKS)", "Amazon Elastic Container Service (Amazon ECS)"],
    ["genai-single-call", "Agentic workflows", "Beyond a single model call.", "Started as a simple RAG chatbot.", "Replace InvokeModel loops.", "Amazon Bedrock", "Amazon Bedrock"],
  ] as const;
  it.each(sourceMention)("requires %s sessions to mention the source side", (source, title, a, b, c, _destination, sourceService) => {
    expect(scoreLensSignals(record(title), profile(source), "next-level").score).toBe(0);
    for (const abstract of [a, b, c]) expect(scoreLensSignals(record(title), profile(source), "next-level", abstract).score).toBe(50);
    const listed = buildIndexRecord({ sessionId: "x", title, services: [sourceService] });
    expect(scoreLensSignals(listed, profile(source), "next-level").score).toBe(0);
  });
  it("does not apply to Fix", () => {
    expect(scoreLensSignals(record("Dead-letter queues"), profile("gap-no-dlq"), "fix").score).toBe(50);
  });
});

describe("Next-level list co-mentions", () => {
  const score = (title: string, abstract: string, source = "serverless", extra: object = {}) =>
    scoreLensSignals(buildIndexRecord({ sessionId: "x", title, ...extra }), profile(source), "next-level", abstract).score;
  it("does not count a destination named only inside an enumeration of three or more names", () => {
    expect(score("Observability tips", "Runs on Lambda today. Works on Lambda, Amazon EC2, ECS and EKS.")).toBe(0);
    expect(score("Observability tips", "Runs on Lambda today. Works on Lambda or EC2 or ECS.")).toBe(0);
    expect(score("Observability tips", "Runs on Lambda today. Works on Lambda, EC2/ECS/EKS.")).toBe(0);
  });
  it("still counts unlisted mentions, and a listing adds nothing to the count", () => {
    expect(score("Deep dive", "Runs on Lambda today. Covers ECS. Then containers.")).toBe(40);
    expect(score("Deep dive", "Runs on Lambda today. Covers ECS. Works on Lambda, EC2, ECS and EKS.")).toBe(0);
    expect(score("Containers deep dive", "Runs on Lambda today. Works on Lambda, EC2, ECS and EKS.")).toBe(50);
  });
  it("treats two names joined by and as too few to be a listing", () => {
    expect(score("Deep dive", "Runs on Lambda today. Covers ECS and EKS. Then containers.")).toBe(40);
  });
  it("does not count a destination in a title enumeration", () => {
    expect(score("Shared storage for Containers, Serverless, and Lambda", "Runs on Lambda today.")).toBe(0);
    expect(score("Shared storage for containers, serverless, and Lambda", "Runs on Lambda today.")).toBe(0);
    expect(score("Shared storage for containers, serverless, and Lambda", "Runs on Lambda today. Containers matter. We use ECS. Also EKS.")).toBe(0);
    expect(score("Storage tips", "Runs on Lambda today. Containers matter. We use ECS. Also EKS.")).toBe(40);
    expect(score("Shared storage for containers, encryption, and auditing", "Runs on Lambda today.")).toBe(50);
  });
  it("does not let a listing satisfy the source side", () => {
    expect(score("Containers deep dive", "Works on Lambda, EC2 and ECS.")).toBe(0);
    expect(score("Containers deep dive", "Runs on Lambda today.")).toBe(50);
    expect(score("Containers, Lambda and EC2", "")).toBe(0);
  });
  it("does not let a tag booster rescue a listed mention", () => {
    const tagged = { services: ["Amazon Elastic Kubernetes Service (Amazon EKS)"], areasOfInterest: ["Kubernetes"] };
    expect(score("Deep dive", "Started on ECS. Works on ECS, EC2, Fargate and EKS.", "ecs", tagged)).toBe(0);
    expect(score("Deep dive", "Started on ECS. Kubernetes and EKS.", "ecs", tagged)).toBe(30 + 20);
  });
});

describe("genai-single-call source and strength", () => {
  const score = (title: string, abstract: string, extra: object = {}) =>
    scoreLensSignals(buildIndexRecord({ sessionId: "x", title, ...extra }), profile("genai-single-call"), "next-level", abstract).score;
  it.each([
    "Started with single-shot prompting.",
    "Beyond basic prompting.",
    "Your first GenAI app is a chatbot.",
    "A RAG baseline answers questions.",
    "We call InvokeModel today.",
    "Your Converse call returns text.",
    "Go from a chatbot to agents.",
    "Grow a simple chatbot into agents.",
    "Extend your existing RAG application.",
    "Beyond a RAG baseline.",
  ])("accepts a starting-point description: %s", starting => {
    expect(score("Agentic workflows", starting)).toBe(50);
  });
  it("does not take Bedrock or prompts alone as the single-call source", () => {
    expect(score("Agentic workflows", "Build on Amazon Bedrock with good prompts.")).toBe(0);
    expect(score("Agentic workflows", "Trusted chatbot answers use RAG retrieval and traces.")).toBe(0);
    expect(score("Agentic workflows", "Move from on-premises to agentic AI. From SAP data to agents.")).toBe(0);
    expect(score("Agentic workflows", "", { services: ["Amazon Bedrock"] })).toBe(0);
  });
  it("needs two agentic mentions, tag or not: a tag never lifts one mention to admission", () => {
    const tagged = { areasOfInterest: ["Agentic AI"] };
    const starting = "Starts from basic prompting today. ";
    expect(score("Deep dive", `${starting}Covers agentic patterns once.`, tagged)).toBe(0);
    expect(score("Deep dive", `${starting}Covers agentic patterns and agentic tools.`)).toBe(40);
    expect(score("Deep dive", `${starting}Covers agentic patterns and agentic tools.`, tagged)).toBe(50);
    expect(score("Deep dive", starting, tagged)).toBe(0);
  });
  it("rejects a Bedrock session that says agentic once in passing", () => {
    const bedrock = { services: ["Amazon Bedrock"], areasOfInterest: ["Agentic AI"] };
    expect(score("Model choice deep dive", "Compare models on Amazon Bedrock with our prompts. We mention agentic once.", bedrock)).toBe(0);
  });
});

describe("genai-single-call source on the profile's own stack", () => {
  const stacked = {
    ...profile("genai-single-call"),
    services: ["AWS Lambda", "AWS Step Functions", "Amazon Bedrock"].map(name => ({ name, catalogName: name, evidence: [citation] })),
  };
  const fits = buildStackFit(stacked);
  const score = (title: string, abstract: string, extra: object = {}) =>
    scoreLensSignals(buildIndexRecord({ sessionId: "x", title, ...extra }), stacked, "next-level", abstract, fits).score;
  it("takes agents built on two of the profile's other services as the move from a single call", () => {
    expect(score("Agentic workflows", "Lambda functions and Step Functions run the tools.")).toBe(50);
    expect(score("Agentic workflows", "Tools.", { services: ["AWS Lambda", "AWS Step Functions"] })).toBe(50);
  });
  it("does not take one other service, or the source service alone", () => {
    expect(score("Agentic workflows", "Lambda functions run the tools.", { services: ["AWS Lambda"] })).toBe(0);
    expect(score("Agentic workflows", "Amazon Bedrock models and prompts.", { services: ["Amazon Bedrock"] })).toBe(0);
  });
  it("does not open other rules' source side", () => {
    const p = { ...stacked, patterns: [{ name: "serverless", evidence: [citation] }] };
    const r = buildIndexRecord({ sessionId: "x", title: "Containers", services: ["AWS Lambda", "AWS Step Functions"] });
    expect(scoreLensSignals(r, p, "next-level", "", fits).score).toBe(0);
  });
});

describe("remediation-tool gate path", () => {
  const iam = "AWS Identity and Access Management (IAM)";
  const stacked = {
    ...profile("gap-broad-iam", "gap-no-cost-monitoring", "gap-no-dlq"),
    services: ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)"].map(name => ({ name, catalogName: name, evidence: [citation] })),
  };
  const fits = buildStackFit(stacked, { minDistinct: 2 });
  const iamTools = [iam, "AWS IAM Access Analyzer"];
  const score = (title: string, abstract: string, services: string[], p: ResolvedProfile = stacked) =>
    scoreLensSignals(buildIndexRecord({ sessionId: "x", title, services }), p, "fix", abstract, fits).score;
  it("admits a remedy-tool session whose title names the phrase, with little of the profile's stack", () => {
    expect(score("Least privilege IAM policies in CI", "", iamTools)).toBe(50);
    expect(score("Cost monitoring and cost allocation", "", ["AWS Billing and Cost Management", "AWS Lambda"])).toBe(50);
  });
  it("admits it when the abstract names the phrase twice, not once", () => {
    expect(score("Ship faster", "We cover least privilege. Then least privilege again.", iamTools)).toBe(40);
    expect(score("Ship faster", "We cover least privilege once.", iamTools)).toBe(0);
    expect(score("Ship faster", "We were missing least privilege.", iamTools)).toBe(0);
  });
  it("counts a remedy service as one of the two services, so IAM alone is not enough", () => {
    expect(score("Least privilege IAM policies in CI", "", [iam])).toBe(0);
    expect(score("Least privilege IAM policies in CI", "", ["AWS IAM Access Analyzer"])).toBe(0);
    expect(score("Production-ready Lambda", "Implement least privilege.", [iam, "AWS Lambda"])).toBe(0);
    expect(score("Least privilege for Lambda", "", [iam, "AWS Lambda"])).toBe(50);
    expect(score("Cost monitoring", "", ["AWS Billing and Cost Management"])).toBe(0);
    expect(score("Cost monitoring", "", ["AWS Billing and Cost Management", "AWS Lambda"])).toBe(50);
  });
  it("needs the remedy service on the session and a rule that names remedy services", () => {
    expect(score("Least privilege IAM policies in CI", "", ["Amazon Aurora"])).toBe(0);
    expect(score("Dead-letter queues", "", iamTools)).toBe(0);
    expect(score("Cost monitoring", "", iamTools)).toBe(0);
  });
  it("does not admit a profile with no core service", () => {
    const bare = { ...stacked, services: [] };
    const r = buildIndexRecord({ sessionId: "x", title: "Least privilege IAM policies in CI", services: iamTools });
    expect(scoreLensSignals(r, bare, "fix", "", buildStackFit(bare, { minDistinct: 2 })).score).toBe(0);
  });
});

describe("testing the profile's own tool", () => {
  const cdk = "AWS Cloud Development Kit (AWS CDK)";
  const service = (name: string, extra = {}) => ({ name, catalogName: name, evidence: [citation], ...extra });
  const withCdk = { ...profile("gap-no-tests", "gap-no-dlq"), services: [service("AWS Lambda"), service("Amazon Simple Queue Service (Amazon SQS)"), service(cdk, { role: "supporting" })] };
  const without = { ...withCdk, services: withCdk.services.slice(0, 2) };
  const score = (p: ResolvedProfile, title: string, services: string[]) =>
    scoreLensSignals(buildIndexRecord({ sessionId: "x", title, services }), p, "fix", "", buildStackFit(p, { minDistinct: 2 })).score;
  it("admits a test-driven infrastructure session for a profile that uses that tool", () => {
    expect(score(withCdk, "Test-driven infrastructure", [cdk, "Kiro"])).toBe(50);
  });
  it("does not admit it for a profile that does not use the tool, or another rule", () => {
    expect(score(without, "Test-driven infrastructure", [cdk, "Kiro"])).toBe(0);
    expect(score(withCdk, "Dead-letter queues", [cdk, "Kiro"])).toBe(0);
    expect(score(withCdk, "Test-driven infrastructure", ["Kiro"])).toBe(0);
  });
});

describe("stack gate", () => {
  it("drops a session the gate rejects, for Fix and Next-level", () => {
    const never = () => false;
    expect(scoreLensSignals(record("Dead-letter queues"), profile("gap-no-dlq"), "fix", "", never).score).toBe(0);
    expect(scoreLensSignals(record("Containers"), profile("serverless"), "next-level", "Lambda", never).score).toBe(0);
    expect(scoreLensSignals(record("Dead-letter queues"), profile("gap-no-dlq"), "fix", "", () => true).score).toBe(50);
  });
});
