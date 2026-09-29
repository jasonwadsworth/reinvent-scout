import { describe, expect, it } from "vitest";
import { buildIndexRecord, type IndexRecord } from "../../src/catalog/index-record.js";
import { buildStackFit } from "../../src/match/stack-fit.js";
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
    const fits = buildStackFit(profile(lambda))!;
    expect(fits(record("Deep dive", ["AWS Lambda"]), "")).toBe(true);
    expect(fits(record("Deep dive", ["Amazon Aurora"]), "")).toBe(false);
  });
  it("fits a session whose title or abstract names a core service by its short name", () => {
    const fits = buildStackFit(profile(lambda, sqs))!;
    expect(fits(record("Lambda tips"), "")).toBe(true);
    expect(fits(record("Queues"), "Learn how SQS scales.")).toBe(true);
    expect(fits(record("Queues"), "Learn how Amazon Simple Queue Service scales.")).toBe(true);
    expect(fits(record("Databases"), "Nothing relevant here.")).toBe(false);
  });
  it("uses the profile's own spelling for a service the catalog does not have", () => {
    const fits = buildStackFit(profile({ name: "Amazon Polly", catalogName: null }))!;
    expect(fits(record("Voices"), "Polly reads text aloud.")).toBe(true);
  });
  it("matches whole words only", () => {
    const fits = buildStackFit(profile({ name: "s3", catalogName: "Amazon Simple Storage Service (Amazon S3)" }))!;
    expect(fits(record("Deep dive"), "The s3rver project.")).toBe(false);
    expect(fits(record("Deep dive"), "Store it in S3.")).toBe(true);
  });
  it("ignores supporting services", () => {
    const fits = buildStackFit(profile(lambda, { name: "apigateway", catalogName: "Amazon API Gateway", role: "supporting" }))!;
    expect(fits(record("Gateway", ["Amazon API Gateway"]), "API Gateway front doors.")).toBe(false);
    expect(fits(record("Lambda"), "")).toBe(true);
  });
  it("is off when the profile has no core service to fit against", () => {
    expect(buildStackFit(profile())).toBeUndefined();
    expect(buildStackFit(profile({ ...lambda, role: "supporting" }))).toBeUndefined();
  });

  describe("minDistinct and rare services", () => {
    const catalog: IndexRecord[] = [
      ...Array.from({ length: 40 }, (_, i) => record(`Filler ${i}`, i < 10 ? ["AWS Lambda"] : [])),
      record("Voices", ["Amazon Polly"]),
    ];
    const polly = { name: "polly", catalogName: "Amazon Polly" };
    it("needs the requested number of distinct services", () => {
      const fits = buildStackFit(profile(lambda, sqs), { minDistinct: 2 })!;
      expect(fits(record("Deep dive", ["AWS Lambda"]), "")).toBe(false);
      expect(fits(record("Deep dive", ["AWS Lambda"]), "Uses SQS.")).toBe(true);
      expect(fits(record("Lambda and SQS"), "")).toBe(true);
    });
    it("counts a service once however many ways it is named", () => {
      const fits = buildStackFit(profile(lambda, { name: "aws_lambda_function", catalogName: "AWS Lambda" }), { minDistinct: 2 })!;
      expect(fits(record("Lambda", ["AWS Lambda"]), "Lambda again.")).toBe(false);
    });
    it("lets one rare service fit alone and computes rarity from the catalog", () => {
      const fits = buildStackFit(profile(lambda, polly), { minDistinct: 2, rareBelow: 0.03, catalog })!;
      expect(fits(record("Voices", ["Amazon Polly"]), "")).toBe(true);
      expect(fits(record("Deep dive", ["AWS Lambda"]), "")).toBe(false);
      expect(fits(record("Deep dive", ["AWS Lambda", "Amazon Polly"]), "")).toBe(true);
    });
    it("does not let a common service ride along with a rare one", () => {
      const fits = buildStackFit(profile(lambda, polly), { minDistinct: 3, rareBelow: 0.03, catalog })!;
      expect(fits(record("Both", ["AWS Lambda", "Amazon Polly"]), "")).toBe(false);
    });
  });
});
