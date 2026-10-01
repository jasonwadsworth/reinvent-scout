import { describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { buildValidateReport } from "../../src/profile/report.js";

const citation = { repo: "api", file: "infra/stack.ts", line: 3, snippet: "new sqs.Queue(this, \"Q\")" };

function profileWith(...patterns: { name: string; note?: string }[]): ResolvedProfile {
  return {
    schemaVersion: 1,
    repos: [{ root: "api", languages: ["typescript"] }],
    services: [],
    patterns: patterns.map(pattern => ({ ...pattern, evidence: [citation] })),
    unresolvedServices: [],
  };
}

describe("validate report warnings", () => {
  it("warns when a gap note names no file, path or glob", () => {
    const report = buildValidateReport(profileWith({ name: "gap-no-dlq", note: "Some queues have no dead-letter queue." }));
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings![0]).toContain("gap-no-dlq");
  });

  it("warns when a gap has no note at all", () => {
    const report = buildValidateReport(profileWith({ name: "gap-no-alarms" }));
    expect(report.warnings?.[0]).toContain("gap-no-alarms");
  });

  it.each([
    ["a file name", "Checked infra/stack.ts: 3 of 4 queues lack a DLQ."],
    ["a bare file name", "Read stack.ts and found 3 of 4 queues without a DLQ."],
    ["a glob", "Grepped every **/cdk-construct.ts for deadLetterQueue: 34 of 37 have one."],
    ["a star-extension glob", "Searched *.tf for dead_letter_config: 2 of 5 have one."],
    ["a nested path", "Searched services/user/src for statements: one grants a wildcard."],
    ["a directory", "Searched services/ for Rule targets: 3 of 37 lack a DLQ."],
    ["a path only the multi-segment branch accepts", "Searched frontend/e2e/specs for a test step: none."],
    ["a bare Dockerfile", "Read the Dockerfile and found no healthcheck."],
    ["a bare Makefile", "Read Makefile for a test target: none."],
    ["go.mod", "Read go.mod: no tracing library."],
    ["pom.xml", "Read pom.xml: no test dependency."],
    ["requirements.txt", "Read requirements.txt: no pytest."],
    ["cdk.json", "Read cdk.json for the app entry: one stack."],
    ["a dot directory", "Read .github/workflows for a test step: none."],
  ])("does not warn when the note names %s", (_label, note) => {
    const report = buildValidateReport(profileWith({ name: "gap-no-dlq", note }));
    expect(report).not.toHaveProperty("warnings");
  });

  it.each([
    ["a slash between two words", "Alarms on 5xx/unhealthy exist for some functions only."],
    ["a verb pair", "Suspend/Resume has no failure destination."],
    ["an IAM action wildcard", "Grants cognito-idp:* to the handler."],
    ["a quoted wildcard resource", "The statement uses resources '*' for the table."],
    ["an ARN with a trailing wildcard", "Allows arn:aws:cognito-idp:us-east-1:111122223333:userpool/* for every pool."],
    ["an ARN with several wildcards", "Allows arn:aws:dynamodb:*:*:table/*/index/* for every table."],
    ["a bare extension list", "Searched .ts and .tf for dead letter queues: none."],
    ["an S3 object wildcard", "Allows s3:GetObject on arn:aws:s3:::bucket/*."],
  ])("still warns when the only slash or star in the note is %s", (_label, note) => {
    const report = buildValidateReport(profileWith({ name: "gap-broad-iam", note }));
    expect(report.warnings).toHaveLength(1);
  });

  it("does not warn about patterns that are not gaps", () => {
    const report = buildValidateReport(profileWith({ name: "serverless", note: "Lambda behind API Gateway." }));
    expect(report).not.toHaveProperty("warnings");
  });

  it("keeps the report byte-identical for a profile without warnings", () => {
    const report = buildValidateReport(profileWith({ name: "serverless" }));
    expect(Object.keys(report)).toEqual(["services", "patterns", "unresolvedServices", "counts", "truncated", "omitted"]);
  });

  it("keeps warnings when the response is truncated", () => {
    const manyServices = Array.from({ length: 40 }, (_, index) => ({
      name: `Service number ${index}`,
      evidence: [citation],
      catalogName: null,
    }));
    const profile = { ...profileWith({ name: "gap-no-dlq", note: "No DLQs." }), services: manyServices };
    const report = buildValidateReport(profile, value => JSON.stringify(value).length < 1200);
    expect(report.truncated).toBe(true);
    expect(report.omitted).toBeGreaterThan(0);
    expect(report.warnings).toHaveLength(1);
  });
});
