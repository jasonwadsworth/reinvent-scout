import { describe, expect, it } from "vitest";
import { buildIndexRecord, type IndexRecord } from "../../src/catalog/index-record.js";
import { buildStackFit, hasCoreService, PLATFORM_SERVICES, PREFIX_REQUIRED_SERVICE_NAMES } from "../../src/match/stack-fit.js";
import type { ResolvedProfile } from "../../src/profile/profile.js";

const evidence = [{ repo: "r", file: "f" }];
const profile = (...services: Array<{ name: string; catalogName: string | null; role?: "core" | "supporting" }>): ResolvedProfile => ({
  schemaVersion: 1, repos: [{ root: "r", languages: [] }],
  services: services.map(service => ({ ...service, evidence })), patterns: [], unresolvedServices: [],
});
const lambda = { name: "lambda", catalogName: "AWS Lambda" };
const sqs = { name: "sqs", catalogName: "Amazon Simple Queue Service (Amazon SQS)" };
const record = (title: string, services: string[] = []) => buildIndexRecord({ sessionId: "x", title, services });

describe("buildStackFit", () => {
  it("fits a session that lists a core service", () => {
    const fits = buildStackFit(profile(lambda));
    expect(fits(record("Deep dive", ["AWS Lambda"]), "")).toBe(true);
    expect(fits(record("Deep dive", ["Amazon Aurora"]), "")).toBe(false);
  });
  it("fits a session whose title or abstract names a core service by its short name", () => {
    const fits = buildStackFit(profile(lambda, sqs));
    expect(fits(record("Lambda tips"), "")).toBe(true);
    expect(fits(record("Queues"), "Learn how SQS scales.")).toBe(true);
    expect(fits(record("Queues"), "Learn how Amazon Simple Queue Service scales.")).toBe(true);
    expect(fits(record("Databases"), "Nothing relevant here.")).toBe(false);
  });
  it("uses the profile's own spelling for a service the catalog does not have", () => {
    const fits = buildStackFit(profile({ name: "Amazon Polly", catalogName: null }));
    expect(fits(record("Voices"), "Amazon Polly reads text aloud.")).toBe(true);
    expect(fits(record("Voices"), "Polly the parrot reads text aloud.")).toBe(false);
  });
  it("matches whole words only", () => {
    const fits = buildStackFit(profile(sqs));
    expect(fits(record("Deep dive"), "The SQSrver project.")).toBe(false);
    expect(fits(record("Deep dive"), "Queue it in SQS.")).toBe(true);
  });
  it("needs the Amazon or AWS prefix for a short name that is an ordinary English word", () => {
    const amplify = buildStackFit(profile({ name: "AWS Amplify", catalogName: "AWS Amplify" }));
    expect(amplify(record("Deep dive"), "Agents amplify all of them.")).toBe(false);
    expect(amplify(record("Deep dive"), "Amplify your reach.")).toBe(false);
    expect(amplify(record("Deep dive"), "Ship it with AWS Amplify.")).toBe(true);
    expect(amplify(record("Deep dive"), "Ship it with aws amplify hosting.")).toBe(true);
    const connect = buildStackFit(profile({ name: "connect", catalogName: "Amazon Connect" }));
    expect(connect(record("Deep dive"), "Connect your systems.")).toBe(false);
    expect(connect(record("Deep dive"), "Route calls with Amazon Connect.")).toBe(true);
    expect(connect(record("Deep dive", ["Amazon Connect"]), "")).toBe(true);
  });
  it("lists the prefix-required names in one exported constant", () => {
    for (const name of ["amplify", "connect", "glue", "batch", "backup", "config", "shield", "inspector", "detective", "transcribe", "polly"]) {
      expect(PREFIX_REQUIRED_SERVICE_NAMES).toContain(name);
    }
    for (const name of ["lambda", "dynamodb", "textract", "kendra"]) expect(PREFIX_REQUIRED_SERVICE_NAMES).not.toContain(name);
  });
  it("matches distinctive product names as capitalized whole words without a prefix", () => {
    const fits = buildStackFit(profile(lambda));
    expect(fits(record("Deep dive"), "Lambda functions scale out.")).toBe(true);
    expect(fits(record("Lambda tips"), "")).toBe(true);
    expect(fits(record("Deep dive"), "A lambda expression in Java.")).toBe(false);
  });
  it("matches an acronym short name case-sensitively as a whole word", () => {
    const fits = buildStackFit(profile(sqs));
    expect(fits(record("Deep dive"), "Queue it in SQS.")).toBe(true);
    expect(fits(record("Deep dive"), "Read ./sqs/config.json first.")).toBe(false);
    expect(fits(record("Deep dive"), "Amazon SQS and friends.")).toBe(true);
    expect(fits(record("Deep dive"), "The SQSrver project.")).toBe(false);
  });
  it("applies the ordinary-word list to the profile's own spelling", () => {
    const amplify = buildStackFit(profile({ name: "Amplify", catalogName: "AWS Amplify" }));
    expect(amplify(record("Deep dive"), "Agents amplify all of them.")).toBe(false);
    expect(amplify(record("Deep dive"), "Amplify your reach.")).toBe(false);
    expect(amplify(record("Deep dive"), "Host it on AWS Amplify.")).toBe(true);
    const connect = buildStackFit(profile({ name: "Connect", catalogName: "Amazon Connect" }));
    expect(connect(record("Deep dive"), "Connect your agents to tools.")).toBe(false);
    expect(connect(record("Deep dive"), "Route calls with Amazon Connect.")).toBe(true);
    const unresolved = buildStackFit(profile({ name: "Glue", catalogName: null }));
    expect(unresolved(record("Deep dive"), "Glue code everywhere.")).toBe(false);
    expect(unresolved(record("Deep dive"), "Run AWS Glue jobs.")).toBe(true);
  });
  it("matches other profile spellings as written unless they equal the catalog name or are covered by its cased short name", () => {
    const resolved = buildStackFit(profile({ name: "kiro", catalogName: "Kiro" }));
    expect(resolved(record("Editor"), "The kiro editor.")).toBe(true);
    const unresolved = buildStackFit(profile({ name: "Kiro", catalogName: null }));
    expect(unresolved(record("Editor"), "The Kiro editor.")).toBe(true);
    expect(unresolved(record("Editor"), "The kiro editor.")).toBe(false);
    expect(buildStackFit(profile(sqs))(record("Queues"), "Poll SQS queues.")).toBe(true);
  });
  it("ignores supporting services", () => {
    const fits = buildStackFit(profile(lambda, { name: "apigateway", catalogName: "Amazon API Gateway", role: "supporting" }));
    expect(fits(record("Gateway", ["Amazon API Gateway"]), "API Gateway front doors.")).toBe(false);
    expect(fits(record("Lambda"), "")).toBe(true);
  });
  it("fits nothing when the profile has no core service to fit against", () => {
    for (const fits of [buildStackFit(profile()), buildStackFit(profile({ ...lambda, role: "supporting" }))]) {
      expect(fits(record("Lambda tips", ["AWS Lambda"]), "Lambda and SQS.")).toBe(false);
    }
  });
  it("reports whether the profile has a core service", () => {
    expect(hasCoreService(profile())).toBe(false);
    expect(hasCoreService(profile({ ...lambda, role: "supporting" }))).toBe(false);
    expect(hasCoreService(profile({ ...lambda, role: "supporting" }, sqs))).toBe(true);
  });

  describe("excluding services", () => {
    const bedrock = { name: "bedrock", catalogName: "Amazon Bedrock" };
    it("ignores the excluded services when deciding fit", () => {
      const fits = buildStackFit(profile(lambda, bedrock));
      const both = record("Agents", ["AWS Lambda", "Amazon Bedrock"]);
      const bedrockOnly = record("Models", ["Amazon Bedrock"]);
      expect(fits(bedrockOnly, "")).toBe(true);
      expect(fits(bedrockOnly, "", { without: ["Amazon Bedrock"] })).toBe(false);
      expect(fits(both, "", { without: ["Amazon Bedrock"] })).toBe(true);
      expect(fits(record("Models"), "Amazon Bedrock and Bedrock again.", { without: ["Amazon Bedrock"] })).toBe(false);
    });
    it("applies the exclusion to the distinct count too", () => {
      const fits = buildStackFit(profile(lambda, sqs, bedrock), { minDistinct: 2 });
      const r = record("Agents", ["AWS Lambda", "Amazon Bedrock"]);
      expect(fits(r, "")).toBe(true);
      expect(fits(r, "", { without: ["Amazon Bedrock"] })).toBe(false);
    });
    it("lets a caller raise the number of distinct services and turns the rare path off", () => {
      const catalog: IndexRecord[] = [...Array.from({ length: 40 }, (_, i) => record(`Filler ${i}`)), record("Queues", ["Amazon Simple Queue Service (Amazon SQS)"])];
      const fits = buildStackFit(profile(lambda, sqs), { minDistinct: 1, rareBelow: 0.05, catalog });
      const one = record("Queues", ["Amazon Simple Queue Service (Amazon SQS)"]);
      expect(fits(one, "")).toBe(true);
      expect(fits(one, "", { minDistinct: 2 })).toBe(false);
      expect(fits(record("Both", ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)"]), "", { minDistinct: 2 })).toBe(true);
    });
  });

  describe("remedy services", () => {
    const iam = "AWS Identity and Access Management (IAM)";
    it("fits a session that lists a remedy service in place of the profile's services", () => {
      const fits = buildStackFit(profile(lambda, sqs), { minDistinct: 2 });
      const remedy = record("Policy tools", [iam]);
      expect(fits(remedy, "")).toBe(false);
      expect(fits(remedy, "", { remedy: [iam] })).toBe(true);
      expect(fits(record("Policy tools", ["Amazon Aurora"]), "", { remedy: [iam] })).toBe(false);
    });
    it("does not open a profile that has no core service", () => {
      const fits = buildStackFit(profile({ ...lambda, role: "supporting" }));
      expect(fits(record("Policy tools", [iam]), "", { remedy: [iam] })).toBe(false);
    });
  });

  describe("platform services", () => {
    const cloudwatch = { name: "cloudwatch", catalogName: "Amazon CloudWatch" };
    const s3 = { name: "s3", catalogName: "Amazon Simple Storage Service (Amazon S3)" };
    const catalog: IndexRecord[] = [
      ...Array.from({ length: 40 }, (_, i) => record(`Filler ${i}`, i < 10 ? ["AWS Lambda"] : [])),
      record("Watching", ["Amazon CloudWatch"]),
    ];
    it("names the platform services once", () => {
      for (const name of ["Amazon CloudWatch", "Amazon Virtual Private Cloud (Amazon VPC)", "Amazon Simple Storage Service (Amazon S3)",
        "Amazon Route 53", "AWS Certificate Manager (ACM)", "AWS Cloud Development Kit (AWS CDK)", "AWS CloudFormation",
        "AWS Identity and Access Management (IAM)", "AWS Security Token Service (AWS STS)", "AWS Key Management Service (AWS KMS)",
        "AWS Secrets Manager", "AWS Systems Manager", "AWS CloudTrail"]) expect(PLATFORM_SERVICES).toContain(name);
      expect(PLATFORM_SERVICES).not.toContain("AWS Lambda");
    });
    it("never counts toward the number of distinct core services", () => {
      const fits = buildStackFit(profile(lambda, cloudwatch, s3), { minDistinct: 2 });
      expect(fits(record("Deep dive", ["AWS Lambda", "Amazon CloudWatch", "Amazon Simple Storage Service (Amazon S3)"]), "")).toBe(false);
      expect(buildStackFit(profile(lambda, sqs, cloudwatch), { minDistinct: 2 })(record("Deep dive", ["AWS Lambda", "Amazon CloudWatch"]), "")).toBe(false);
      expect(buildStackFit(profile(lambda, sqs, cloudwatch), { minDistinct: 2 })(record("Deep dive", ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)"]), "")).toBe(true);
    });
    it("never counts as the one rare service", () => {
      const fits = buildStackFit(profile(lambda, cloudwatch), { minDistinct: 2, rareBelow: 0.03, catalog });
      expect(fits(record("Watching", ["Amazon CloudWatch"]), "")).toBe(false);
    });
    it("leaves a profile with only platform services without a core", () => {
      expect(hasCoreService(profile(cloudwatch, s3))).toBe(false);
      expect(hasCoreService(profile(cloudwatch, lambda))).toBe(true);
      expect(buildStackFit(profile(cloudwatch))(record("Watching", ["Amazon CloudWatch"]), "CloudWatch")).toBe(false);
    });
  });

  describe("minDistinct and rare services", () => {
    const catalog: IndexRecord[] = [
      ...Array.from({ length: 40 }, (_, i) => record(`Filler ${i}`, i < 10 ? ["AWS Lambda"] : [])),
      record("Voices", ["Amazon Polly"]),
    ];
    const polly = { name: "polly", catalogName: "Amazon Polly" };
    it("never treats an unresolved service name as rare", () => {
      const playwright = { name: "Playwright", catalogName: null };
      const fits = buildStackFit(profile(lambda, playwright), { minDistinct: 2, rareBelow: 0.03, catalog });
      expect(fits(record("Browser tests"), "Drive Playwright from a script.")).toBe(false);
      expect(fits(record("Browser tests", ["AWS Lambda"]), "Drive Playwright from a script.")).toBe(true);
      expect(buildStackFit(profile(playwright))(record("Browser tests"), "Drive Playwright from a script.")).toBe(true);
    });
    it("needs the requested number of distinct services", () => {
      const fits = buildStackFit(profile(lambda, sqs), { minDistinct: 2 });
      expect(fits(record("Deep dive", ["AWS Lambda"]), "")).toBe(false);
      expect(fits(record("Deep dive", ["AWS Lambda"]), "Uses SQS.")).toBe(true);
      expect(fits(record("Lambda and SQS"), "")).toBe(true);
    });
    it("counts a service once however many ways it is named", () => {
      const fits = buildStackFit(profile(lambda, { name: "aws_lambda_function", catalogName: "AWS Lambda" }), { minDistinct: 2 });
      expect(fits(record("Lambda", ["AWS Lambda"]), "Lambda again.")).toBe(false);
    });
    it("lets one rare service fit alone and computes rarity from the catalog", () => {
      const fits = buildStackFit(profile(lambda, polly), { minDistinct: 2, rareBelow: 0.03, catalog });
      expect(fits(record("Voices", ["Amazon Polly"]), "")).toBe(true);
      expect(fits(record("Deep dive", ["AWS Lambda"]), "")).toBe(false);
      expect(fits(record("Deep dive", ["AWS Lambda", "Amazon Polly"]), "")).toBe(true);
    });
    it("does not let a common service ride along with a rare one", () => {
      const fits = buildStackFit(profile(lambda, polly), { minDistinct: 3, rareBelow: 0.03, catalog });
      expect(fits(record("Both", ["AWS Lambda", "Amazon Polly"]), "")).toBe(false);
    });
  });
});
