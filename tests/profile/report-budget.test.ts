import { describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../../src/profile/profile.js";
import { buildValidateReport } from "../../src/profile/report.js";

const citation = { repo: "api", file: "a.ts", line: 1 };

describe("validate report budget", () => {
  it("truncates patterns too, not just services, when many long pattern names alone would blow the budget", () => {
    const profile: ResolvedProfile = {
      schemaVersion: 1,
      repos: [{ root: "api", languages: ["typescript"] }],
      services: [{ name: "lambda", catalogName: null, evidence: [citation] }],
      patterns: Array.from({ length: 100 }, (_, index) => ({ name: `pattern-${"p".repeat(40)}-${index}`, evidence: [citation] })),
      unresolvedServices: ["lambda"],
    };
    const fits = (value: unknown) => JSON.stringify(value).length < 2000;
    const report = buildValidateReport(profile, fits);
    expect(report.truncated).toBe(true);
    expect(report.counts.patterns).toBe(100);
    expect(report.patterns.length).toBeGreaterThan(0);
    expect(report.patterns.length).toBeLessThan(100);
    expect(fits(report)).toBe(true);
  });
});
