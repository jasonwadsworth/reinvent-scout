import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { scoreLensSignals } from "../../src/match/lens-signals.js";
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
    expect(result.score).toBe(30);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatchObject({ kind: "pillarGap", weight: 30, profileEvidence: [citation] });
    expect(result.reasons[0]!.detail).toContain(name);
    expect(result.reasons[0]!.detail).toContain(pillar);
    expect(result.reasons[0]!.detail).toContain(name === "gap-broad-iam" ? "scope concern" : "not evident in the cited scope");
    expect(title.toLowerCase()).toContain(result.reasons[0]!.evidence.toLowerCase());
  });
  it.each(gaps)("rejects broad subject overlap for %s", (name, _pillar, _title, broadTitle) => {
    expect(scoreLensSignals(record(broadTitle), profile(name), "fix")).toEqual({ score: 0, reasons: [] });
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
    expect(result.score).toBe(30);
    expect(result.reasons[0]!.profileEvidence).toEqual([citation, { ...citation, file: "other.ts" }]);
  });
  it("adds distinct rules with their own sources", () => {
    const result = scoreLensSignals(record("Alarms and dead-letter queues"), profile("gap-no-dlq", "gap-no-alarms"), "fix");
    expect(result.reasons).toHaveLength(2);
    expect(result.score).toBe(60);
    expect(result.score).toBe(result.reasons.reduce((sum, reason) => sum + reason.weight, 0));
  });
  it("uses contiguous whole phrases from abstract text, not bag-of-words overlap", () => {
    const r = record("Queue operations");
    expect(scoreLensSignals(r, profile("gap-no-dlq"), "fix", "Learn Dead-Letter queues.").reasons[0]?.evidence).toBe("Dead-Letter queues");
    expect(scoreLensSignals(r, profile("gap-no-load-tests"), "fix", "Balance load while testing unrelated features.").score).toBe(0);
    expect(scoreLensSignals(record("Download testing tools"), profile("gap-no-load-tests"), "fix").score).toBe(0);
    expect(scoreLensSignals(record("An alarming tale"), profile("gap-no-alarms"), "fix").score).toBe(0);
  });
  it("accepts a narrow exact catalog area but rejects a broad taxonomy tag", () => {
    expect(scoreLensSignals(buildIndexRecord({ sessionId: "x", title: "Deep dive", areasOfInterest: ["Observability"] }), profile("gap-no-alarms"), "fix").reasons[0]?.evidence).toBe("Observability");
    expect(scoreLensSignals(buildIndexRecord({ sessionId: "x", title: "Deep dive", topics: ["Security & Identity"], services: ["AWS Identity and Access Management (IAM)"] }), profile("gap-broad-iam"), "fix").score).toBe(0);
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
    expect(result.score).toBe(30);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatchObject({ kind: "migrationPath", weight: 30, profileEvidence: [citation] });
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
  it("matches exact destination services and areas, without suppressing mixed architectures", () => {
    for (const service of ["Amazon Elastic Container Service (Amazon ECS)", "Amazon Elastic Kubernetes Service (Amazon EKS)"]) {
      const r = buildIndexRecord({ sessionId: "x", title: "Deep dive", services: [service] });
      const result = scoreLensSignals(r, profile("SERVERLESS", "ecs"), "next-level");
      expect(result.reasons[0]?.evidence).toBe(service);
      expect(result.reasons).toHaveLength(service.includes("Kubernetes") ? 2 : 1);
    }
    const kubernetes = buildIndexRecord({ sessionId: "x", title: "Deep dive", areasOfInterest: ["Kubernetes"] });
    expect(scoreLensSignals(kubernetes, profile("ecs"), "next-level").reasons[0]?.evidence).toBe("Kubernetes");
    const r = buildIndexRecord({ sessionId: "x", title: "Deep dive", areasOfInterest: ["Agentic AI"] });
    expect(scoreLensSignals(r, profile("genai-single-call", "agentic"), "next-level").reasons[0]?.evidence).toBe("Agentic AI");
  });
  it("handles prototype vocabulary safely on both sides after JSON parsing", () => {
    const r = JSON.parse(JSON.stringify(buildIndexRecord({ sessionId: "constructor", title: "constructor", services: ["constructor"], areasOfInterest: ["constructor"], topics: ["constructor"] })));
    expect(scoreLensSignals(r, profile("constructor"), "next-level")).toEqual({ score: 0, reasons: [] });
    expect(scoreLensSignals(r, profile("serverless"), "next-level")).toEqual({ score: 0, reasons: [] });
  });
});
