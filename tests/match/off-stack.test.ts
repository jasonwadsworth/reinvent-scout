import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { demotionReason } from "../../src/match/all.js";
import { offStackAbout, offStackOf } from "../../src/match/off-stack.js";
import { OFF_STACK_TOOLS } from "../../src/match/stack-fit.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const cite = { repo: "repo", file: "a.ts", line: 1 };
const profile = (services: Array<{ name: string; catalogName?: string | null }>, patterns: string[] = []): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: services.map(service => ({ name: service.name, catalogName: service.catalogName === undefined ? service.name : service.catalogName, evidence: [cite] })),
  patterns: patterns.map(name => ({ name, evidence: [cite] })), unresolvedServices: [],
});
const CATALOG = [
  "AWS Lambda", "Amazon Kinesis", "AWS Fargate", "Amazon Connect", "Amazon Elastic Kubernetes Service (Amazon EKS)", "Amazon Bedrock",
  "Amazon Bedrock AgentCore", "AWS GovCloud (US)", "Amazon Aurora", "Amazon Aurora DSQL", "AWS Identity and Access Management (IAM)",
  "Amazon Simple Storage Service (Amazon S3)", "Amazon Elastic Compute Cloud (Amazon EC2)", "AWS Transform", "AWS Command Line Interface (AWS CLI)",
  "Amazon DynamoDB", "Amazon Managed Streaming for Apache Kafka (Amazon MSK)", "Kiro",
];
const about = (p: ResolvedProfile, title: string) => offStackAbout(title, offStackOf(p, CATALOG));
const lambda = profile([{ name: "AWS Lambda" }], ["serverless"]);

describe("which technology a title is about", () => {
  it("names a catalog service or a curated tool the profile does not use, and not one it does", () => {
    expect(about(lambda, "Serverless containers on AWS Fargate")).toBe("AWS Fargate");
    expect(about(lambda, "Building serverless applications with Terraform")).toBe("Terraform");
    expect(about(lambda, "Serverless at scale with AWS Lambda")).toBeUndefined();
    expect(about(profile([{ name: "AWS Lambda" }, { name: "Terraform" }]), "Building with Terraform")).toBeUndefined();
  });

  it("looks at the title only", () => {
    const record = buildIndexRecord({ sessionId: "s", title: "Serverless applications at scale" });
    const off = offStackOf(lambda, CATALOG);
    expect(demotionReason(record, "Master Terraform and AWS Fargate with Kafka.", { offStack: off })).toBeUndefined();
  });

  it("does not take the short form of a product for an ordinary word", () => {
    for (const title of ["What Building an SRE Agent Taught Us About Agents", "Lessons for us all", "Everything about us", "Building for US government"]) {
      expect(about(lambda, title), title).toBeUndefined();
    }
    expect(about(lambda, "Migrating to AWS GovCloud (US)")).toBe("AWS GovCloud");
  });

  it("names a service by its full name or its prefixed short form, and its bare name only as a product word, in the right case", () => {
    expect(about(lambda, "Amazon EKS best practices")).toBe("Amazon Elastic Kubernetes Service");
    expect(about(lambda, "Fast S3 tips")).toBeUndefined();
    expect(about(lambda, "Tuning EC2 fleets")).toBe("Amazon Elastic Compute Cloud");
    expect(about(profile([{ name: "AWS Lambda" }], []), "Amazon Kinesis data streams")).toBe("Amazon Kinesis");
    expect(about(lambda, "dynamodb tips")).toBeUndefined();
    expect(about(lambda, "Amazon DynamoDB tips")).toBe("Amazon DynamoDB");
    expect(about(lambda, "DynamoDB tips")).toBe("Amazon DynamoDB");
    expect(about(lambda, "aws fargate tips")).toBe("AWS Fargate");
    expect(about(lambda, "Transform your SaaS")).toBeUndefined();
    expect(about(lambda, "CLI Agent Orchestrator")).toBeUndefined();
    expect(about(lambda, "terraform tips")).toBeUndefined();
    expect(about(lambda, "Terraform tips")).toBe("Terraform");
    expect(about(lambda, "Apache Spark jobs")).toBe("Spark");
    expect(about(lambda, "Sparkling builds")).toBeUndefined();
    expect(about(lambda, "Spec-driven development with Kiro")).toBe("Kiro");
  });

  it("never names a platform service, such as IAM", () => {
    expect(about(lambda, "Multi-tenant isolation with AWS Identity and Access Management")).toBeUndefined();
    expect(about(lambda, "IAM Identity Center at scale")).toBeUndefined();
    expect(about(lambda, "Amazon S3 patterns")).toBeUndefined();
  });

  it("resolves the longer service: a name inside a used service's name is not off-stack", () => {
    const agentcore = profile([{ name: "Amazon Bedrock AgentCore" }]);
    expect(about(agentcore, "A governed semantic layer with Amazon Bedrock AgentCore and MCP")).toBeUndefined();
    expect(about(agentcore, "Using Amazon Bedrock with AgentCore Memory")).toBe("Amazon Bedrock");
    expect(about(lambda, "Agents with Amazon Bedrock AgentCore")).toBe("Amazon Bedrock AgentCore");
    expect(about(profile([{ name: "Amazon Aurora" }]), "Scaling Amazon Aurora DSQL")).toBeUndefined();
  });

  it("does not demote a technology that directly qualifies a service the profile uses", () => {
    const aurora = profile([{ name: "Amazon Aurora" }]);
    expect(about(aurora, "Agentic hybrid retrieval with Amazon Aurora PostgreSQL")).toBeUndefined();
    expect(about(aurora, "Amazon Aurora - PostgreSQL edition")).toBeUndefined();
    expect(about(aurora, "Amazon Aurora and PostgreSQL migration")).toBe("PostgreSQL");
    expect(about(lambda, "Hybrid retrieval with PostgreSQL")).toBe("PostgreSQL");
  });

  it("counts a tool as used through a service's catalog name alone, or a pattern's wording", () => {
    const eks = profile([{ name: "my-cluster", catalogName: "Amazon Elastic Kubernetes Service (Amazon EKS)" }]);
    expect(about(eks, "Kubernetes in practice")).toBeUndefined();
    expect(about(profile([], ["eks"]), "Kubernetes in practice")).toBeUndefined();
    expect(about(lambda, "Kubernetes in practice")).toBe("Kubernetes");
    expect(about(profile([{ name: "tf", catalogName: "Terraform" }]), "Terraform in practice")).toBeUndefined();
    expect(about(profile([{ name: "Terraform", catalogName: "AWS Lambda" }]), "Terraform in practice")).toBeUndefined();
  });

  it("exempts a comparison only when it names two technologies", () => {
    expect(about(lambda, "Lambda vs Terraform: which to pick")).toBeUndefined();
    expect(about(lambda, "Choosing between Terraform and AWS Lambda")).toBeUndefined();
    expect(about(lambda, "Terraform instead of AWS Lambda")).toBeUndefined();
    expect(about(lambda, "Terraform versus AWS Lambda")).toBeUndefined();
    expect(about(lambda, "Comparing Terraform and AWS Lambda")).toBeUndefined();
    expect(about(lambda, "Migrating from Kafka to Amazon Kinesis")).toBeUndefined();
    expect(about(lambda, "From Zero to 20,000 Desktops with Terraform")).toBe("Terraform");
    expect(about(lambda, "Terraform vs plain scripts")).toBe("Terraform");
    expect(about(lambda, "Terraform instead of shell scripts")).toBe("Terraform");
    expect(about(lambda, "Comparing build pipelines for Terraform")).toBe("Terraform");
  });
});

describe("the technologies a profile does not use", () => {
  it("leaves out the services it names, the platform services, and the tools it uses", () => {
    const labels = (p: ResolvedProfile) => offStackOf(p, CATALOG).topics.map(topic => topic.label);
    expect(labels(lambda)).toContain("AWS Fargate");
    expect(labels(lambda)).not.toContain("AWS Lambda");
    expect(labels(lambda)).not.toContain("AWS Identity and Access Management");
    expect(labels(profile([{ name: "AWS Fargate" }]))).not.toContain("AWS Fargate");
  });

  it("names both reasons once when a title is about an unused broad topic and an unused technology", () => {
    const record = buildIndexRecord({ sessionId: "s", title: "Agentic apps with Terraform" });
    const absent = [{ label: "agents", phrase: /\bagentic\b/i }];
    expect(demotionReason(record, "", { absent, offStack: offStackOf(lambda, CATALOG) })).toBe("about agents and Terraform, which this code does not use");
  });
});

describe("OFF_STACK_TOOLS", () => {
  const evidence = JSON.parse(readFileSync(join(here, "..", "fixtures", "off-stack-tool-titles.json"), "utf8")) as Record<string, Array<{ code: string; title: string }>>;

  it("lists only third-party tools or platforms named in the titles of at least two catalog sessions, evidenced in the fixture", () => {
    for (const tool of OFF_STACK_TOOLS) {
      const sessions = evidence[tool] ?? [];
      expect(new Set(sessions.map(session => session.code)).size, tool).toBeGreaterThanOrEqual(2);
      const word = new RegExp(`(?<![\\w-])${tool}(?![\\w-])`);
      for (const session of sessions) expect(word.test(session.title), `${tool}: ${session.title}`).toBe(true);
    }
  });

  it("has no duplicate, and leaves out a Lambda feature and a tool no title names", () => {
    expect(new Set(OFF_STACK_TOOLS).size).toBe(OFF_STACK_TOOLS.length);
    for (const left of ["MicroVMs", "Pulumi", "Flink"]) expect(OFF_STACK_TOOLS).not.toContain(left);
  });
});
