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
    ["a directory path", "Searched services/ for Rule targets: 3 of 37 lack a DLQ."],
  ])("does not warn when the note names %s", (_label, note) => {
    const report = buildValidateReport(profileWith({ name: "gap-no-dlq", note }));
    expect(report).not.toHaveProperty("warnings");
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
    const report = buildValidateReport(
      profileWith({ name: "gap-no-dlq", note: "No DLQs." }),
      value => JSON.stringify(value).length < 400,
    );
    expect(report.warnings).toHaveLength(1);
  });
});
