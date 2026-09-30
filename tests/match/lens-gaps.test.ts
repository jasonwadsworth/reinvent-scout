import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { buildStackFit } from "../../src/match/stack-fit.js";
import { scoreLensSignals } from "../../src/match/lens-signals.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const citation = { repo: "checkout", file: "infra/stack.ts", line: 7, snippet: "new Function(stack)", note: "Inspected this deployment scope." };
const service = (name: string) => ({ name, catalogName: name, evidence: [citation] });
const stacked = (...gaps: string[]): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "checkout", languages: [] }],
  services: ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)"].map(service),
  patterns: gaps.map(name => ({ name, evidence: [citation] })), unresolvedServices: [],
});

interface GapCase {
  rule: string;
  pillar: string;
  /** Titles that name the remedy. */
  titles: string[];
  /** Words the remedy shares with ordinary prose; alone, even repeated, they admit nothing. */
  common: string[];
  remedy: string;
  /** A title that names the remedy only inside an enumeration of names. */
  listed: string;
}

const CASES: GapCase[] = [
  { rule: "gap-no-tracing", listed: "Lambda, SQS and AWS X-Ray", pillar: "Operational Excellence", remedy: "AWS Distro for OpenTelemetry",
    titles: ["Distributed tracing for microservices", "Instrument a service with OpenTelemetry", "Debugging with AWS X-Ray", "End-to-end tracing on serverless"],
    common: ["Tracing", "Trace the request", "Tracing paper", "Hotel booking", "Ray tracing for graphics"] },
  { rule: "gap-no-ci", listed: "Lambda, SQS and CI/CD", pillar: "Operational Excellence", remedy: "AWS CodePipeline",
    titles: ["CI/CD on AWS", "Continuous delivery for serverless", "Modernize your deployment pipelines", "Continuous integration in practice"],
    common: ["Pipelines", "Data pipelines at scale", "Continuous learning", "Delivery of packages", "Integration patterns"] },
  { rule: "gap-no-backups", listed: "Lambda, SQS and AWS Backup", pillar: "Reliability", remedy: "AWS Backup",
    titles: ["AWS Backup for centralized protection", "Point-in-time recovery for your tables", "Backup plans that hold up", "Immutable backups against ransomware"],
    common: ["Backup", "Back up your laptop", "Backups", "Recovery", "Backup singers"] },
  { rule: "gap-no-waf", listed: "Lambda, SQS and AWS WAF", pillar: "Security", remedy: "AWS WAF",
    titles: ["AWS WAF for your APIs", "Bot defense with WAF", "Web application firewalls in practice"],
    common: ["Firewalls", "Wafer fabrication", "Waffles", "Application security", "Firewall rules"] },
  { rule: "gap-no-caching", listed: "Lambda, SQS and Edge Caching", pillar: "Performance Efficiency", remedy: "Amazon ElastiCache",
    titles: ["Caching strategies for read-heavy APIs", "An in-memory cache in front of your database", "Edge caching with CloudFront", "Cache hit ratios that pay off"],
    common: ["Cache", "Cashing checks", "Semantic caching for prompts", "Prompt caching", "Caches"] },
  { rule: "gap-no-graviton", listed: "Lambda, SQS and Graviton", pillar: "Sustainability", remedy: "Amazon EC2 - Graviton",
    titles: ["Moving to arm64", "Graviton for Lambda", "Reducing cost with Graviton5", "Graviton 4 migration"],
    common: ["ARM holdings", "Gravity", "Armed forces"] },
];

describe.each(CASES)("$rule", ({ rule, pillar, titles, common, remedy, listed }) => {
  const record = (title: string, services: string[] = []) => buildIndexRecord({ sessionId: "x", title, services });
  const score = (title: string, abstract = "", services: string[] = []) =>
    scoreLensSignals(record(title, services), stacked(rule), "fix", abstract).score;

  it.each(titles)("admits a title that names the remedy: %s", title => {
    const result = scoreLensSignals(record(title), stacked(rule), "fix");
    expect(result.score).toBe(50);
    expect(result.reasons[0]!.detail).toContain(pillar);
    expect(result.reasons[0]!.detail).toContain("not evident in the cited scope");
  });
  it("admits an abstract that names the remedy twice, not once", () => {
    const remedyText = titles[0]!;
    expect(score("Deep dive", `We cover ${remedyText.toLowerCase()} and then ${remedyText.toLowerCase()}.`)).toBe(40);
    expect(score("Deep dive", `We cover ${remedyText.toLowerCase()} in passing.`)).toBe(0);
  });
  it.each(common)("rejects a common-word false positive, even repeated: %s", title => {
    expect(score(title, `${title}. Again: ${title}.`)).toBe(0);
  });
  it("rejects a title that lists the remedy among other names", () => {
    expect(score(listed)).toBe(0);
  });
  it("rejects a session whose text only lists the remedy among names", () => {
    expect(score("Deep dive", `Covers ${listed}. Also ${listed}.`)).toBe(0);
  });
  it("does not fire for a profile without the gap", () => {
    expect(scoreLensSignals(record(titles[0]!), stacked("gap-no-dlq"), "fix").score).toBe(0);
  });

  describe("stack gate", () => {
    const fits = buildStackFit(stacked(rule), { minDistinct: 2 });
    const gated = (title: string, abstract: string, services: string[]) =>
      scoreLensSignals(record(title, services), stacked(rule), "fix", abstract, fits).score;
    it("rejects an off-stack session that lists none of the profile's services or the remedy", () => {
      expect(gated(titles[0]!, "", ["Amazon Redshift"])).toBe(0);
      expect(gated(titles[0]!, "", ["Amazon Redshift", "Amazon Kinesis"])).toBe(0);
    });
    it("admits a remedy session that also lists one of the profile's core services", () => {
      expect(gated(titles[0]!, "", [remedy, "AWS Lambda"])).toBe(50);
    });
    it("rejects the remedy service alone, or a passing mention of the phrase, on the remedy path", () => {
      expect(gated(titles[0]!, "", [remedy])).toBe(0);
      expect(gated("Deep dive", `We cover ${titles[0]!.toLowerCase()}.`, [remedy, "AWS Lambda"])).toBe(0);
    });
    it("admits a session on two of the profile's own services without the remedy service", () => {
      expect(gated(titles[0]!, "", ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)"])).toBe(50);
    });
  });
});
