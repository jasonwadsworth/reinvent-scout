import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  ["gap-no-alarms", "Operational Excellence", "Observability and alarms", "Operational best practices"],
  ["gap-no-tests", "Operational Excellence", "Automated testing strategies", "Application development with latest tools"],
  ["gap-broad-iam", "Security", "Least privilege IAM policies", "Security best practices"],
  ["gap-no-load-tests", "Performance Efficiency", "Load testing distributed applications", "High performance compute"],
  ["gap-no-cost-monitoring", "Cost Optimization", "Cost monitoring and cost allocation", "Save money on cloud costs"],
  ["gap-no-resource-rightsizing", "Sustainability", "Resource rightsizing", "Sustainable resources for the future"],
] as const;

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
    const result = scoreLensSignals(record("Alarms and dead-letter queues"), profile("gap-no-dlq", "gap-no-alarms"), "fix");
    expect(result.reasons).toHaveLength(2);
    expect(result.score).toBe(100);
    expect(result.score).toBe(result.reasons.reduce((sum, reason) => sum + reason.weight, 0));
  });
  it("uses contiguous whole phrases from abstract text, not bag-of-words overlap", () => {
    const r = record("Queue operations");
    expect(scoreLensSignals(r, profile("gap-no-dlq"), "fix", "Learn Dead-Letter queues.").reasons[0]?.evidence).toBe("Dead-Letter queues");
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
    expect(strengthOf("Deep dive", "Mentions dead-letter queues once.", "gap-no-dlq")).toBe(30);
  });
  it("adds one strength when the abstract describes the phrase as missing", () => {
    const weight = (abstract: string) => scoreLensSignals(record("Deep dive"), profile("gap-no-dlq"), "fix", abstract).reasons[0]?.weight;
    expect(weight("Anti-patterns such as missing dead-letter queues.")).toBe(40);
    expect(weight("Systems without any dead-letter queues fail.")).toBe(40);
    expect(weight("Anti-patterns such as dead-letter queues.")).toBe(30);
    expect(weight("We had no idea about many other things, then dead-letter queues.")).toBe(30);
  });
  it("lets a matching tag add one strength but only on top of a text hit", () => {
    const r = buildIndexRecord({ sessionId: "x", title: "Deep dive", areasOfInterest: ["Monitoring & Observability"] });
    expect(scoreLensSignals(r, profile("gap-no-alarms"), "fix", "Set up an alarm for the queue.").reasons[0]?.weight).toBe(40);
    expect(scoreLensSignals(record("Deep dive"), profile("gap-no-alarms"), "fix", "Set up an alarm for the queue.").reasons[0]).toBeUndefined();
  });
  it("does not treat the bare word observability as an alarms signal", () => {
    expect(scoreLensSignals(record("Observability deep dive"), profile("gap-no-alarms"), "fix", "Observability and observability again.").score).toBe(0);
    expect(scoreLensSignals(record("Alerting and anomaly detection"), profile("gap-no-alarms"), "fix").score).toBe(50);
  });
  it("reports which rule admitted the session and at what strength", () => {
    const result = scoreLensSignals(record("Alarms and dead-letter queues"), profile("gap-no-dlq", "gap-no-alarms"), "fix");
    expect(result.hits).toEqual([{ rule: "gap-no-dlq", strength: 3 }, { rule: "gap-no-alarms", strength: 3 }]);
  });
});

const paths = [
  ["serverless", "Containers", "containers", "runtime control", "operational ownership"],
  ["ecs", "Kubernetes", "EKS", "portability", "complexity"],
  ["genai-single-call", "Agentic workflows", "agentic", "multi-step tool use", "latency"],
] as const;

describe("Next-level signals", () => {
  it.each(paths)("offers %s to %s with gains and costs", (source, title, destination, gain, cost) => {
    const result = scoreLensSignals(record(title), profile(source), "next-level");
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
    expect(scoreLensSignals(r, profile("ecs"), "next-level", "Run it on Kubernetes.").reasons[0]?.weight).toBe(40);
    expect(scoreLensSignals(r, profile("ecs"), "next-level").score).toBe(0);
  });
  const reverseCases = [
    ["serverless", "Replacing always-on containers with MicroVMs as per-tenant sandboxes; containers cost more."],
    ["serverless", "Lambda MicroVMs run containers and containers."],
    ["serverless", "We migrate containers to Lambda functions, containers included."],
    ["ecs", "Move from Amazon EKS clusters to Amazon ECS; Kubernetes and Kubernetes again."],
  ] as const;
  it.each(reverseCases)("excludes a reverse-direction %s session: %s", (source, abstract) => {
    expect(scoreLensSignals(record("Compute deep dive"), profile(source), "next-level", abstract).score).toBe(0);
  });
  it("excludes a reverse-direction title as well", () => {
    expect(scoreLensSignals(record("Lambda MicroVMs for containers"), profile("serverless"), "next-level").score).toBe(0);
  });
  it("skips a path whose destination pattern the profile already has, case-insensitively", () => {
    for (const [source, destination] of [["serverless", "Containers"], ["ecs", "EKS"], ["genai-single-call", "AGENTIC"]] as const) {
      const title = source === "serverless" ? "Containers" : source === "ecs" ? "Kubernetes" : "Agentic workflows";
      expect(scoreLensSignals(record(title), profile(source), "next-level").score).toBe(50);
      expect(scoreLensSignals(record(title), profile(source, destination), "next-level").score).toBe(0);
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
