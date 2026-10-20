import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/aws/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_EVENT_ID, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { OUTPUT_BUDGET_BYTES } from "../../src/commands/output-budget.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: DEFAULT_EVENT_ID,
    syncedAt: 1_700_000_000_000,
    totalCount: fixture.length,
    count: fixture.length,
    includedAbstracts: true,
    timezone: null,
    ...overrides,
  };
}

function seedFixtureCatalog(storeRoot: string): void {
  writeCatalog(
    { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
    { storeRoot },
  );
}

function lambdaProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: ["typescript"] }],
    services: [{ name: "lambda", evidence: [{ repo: ".", file: "src/handler.ts", line: 3 }] }],
    patterns: [],
  };
}

describe("validate_profile tool", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("resolves a profile's service names and reports unresolved ones", async () => {
    seedFixtureCatalog(home.path);

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [
        { name: "lambda", evidence: [{ repo: ".", file: "a" }] },
        { name: "some-service-with-no-catalog-counterpart", evidence: [{ repo: ".", file: "b" }] },
      ],
      patterns: [],
    };

    const result = await callCommand("validate_profile", { profile }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.text) as {
      services: Array<{ name: string; catalogName: string | null }>;
      unresolvedServices: string[];
    };
    expect(parsed.services.find((s) => s.name === "lambda")?.catalogName).toBe("AWS Lambda");
    expect(parsed.unresolvedServices).toEqual(["some-service-with-no-catalog-counterpart"]);
  });

  it("returns a compact result -- pattern names and counts, never an evidence echo of the agent's own input", async () => {
    // pr-reviewer's finding: echoing the whole resolved profile (evidence, repos, usage notes and
    // all) breaks the README's own "every tool holds its response to a 30 KB budget" claim for a
    // large profile. The tool only needs to report what it actually resolved.
    seedFixtureCatalog(home.path);

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: [{ name: "lambda", usage: "the order handler", evidence: [{ repo: ".", file: "a.ts", line: 12 }] }],
      patterns: [{ name: "serverless", note: "API Gateway in front", evidence: [{ repo: ".", file: "b.ts" }] }],
    };

    const result = await callCommand("validate_profile", { profile }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    const raw = result.text;
    // The evidence file paths and the usage/note text must not appear anywhere in the response --
    // a substring check across the whole raw text, not just the parsed shape, since an evidence
    // echo could in principle hide under a differently-named field.
    expect(raw).not.toMatch(/a\.ts/);
    expect(raw).not.toMatch(/b\.ts/);
    expect(raw).not.toMatch(/order handler/);
    expect(raw).not.toMatch(/API Gateway in front/);
    expect(raw).not.toMatch(/"repos"/);

    const parsed = JSON.parse(raw) as {
      services: Array<{ name: string; catalogName: string | null }>;
      patterns: string[];
      unresolvedServices: string[];
      counts: { services: number; patterns: number; unresolvedServices: number };
    };
    expect(parsed.services).toEqual([{ name: "lambda", catalogName: "AWS Lambda" }]);
    expect(parsed.patterns).toEqual(["serverless"]);
    expect(parsed.counts).toEqual({ services: 1, patterns: 1, unresolvedServices: 0 });
  });

  it("stays under the 24 KiB response budget for a profile naming 120 services", async () => {
    // pr-reviewer's own measurement: the old full-echo response for a 120-service profile was
    // 45,439 bytes -- comfortably over budget. The compact shape must stay under it, and truncate
    // (reporting how many were omitted) on the rare case it somehow doesn't.
    seedFixtureCatalog(home.path);

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: Array.from({ length: 120 }, (_, i) => ({
        name: `unresolvable-service-number-${i}`,
        evidence: [{ repo: ".", file: `src/service-${i}.ts`, line: i + 1 }],
      })),
      patterns: [],
    };

    const result = await callCommand("validate_profile", { profile }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    const raw = result.text;
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const parsed = JSON.parse(raw) as { services: unknown[]; counts: { services: number } };
    expect(parsed.counts.services).toBe(120); // the true count, even if services[] itself is truncated
    expect(parsed.services).toHaveLength(120); // 120 tiny entries comfortably fit; nothing truncated
  });

  it("truncates the services list, reporting the true count and an omitted count, when even the compact shape doesn't fit", async () => {
    // Directly exercises the truncation branch itself (unlike the 120-service test above, which
    // stays under budget without ever needing it) -- long enough service names, enough of them,
    // that the compact shape genuinely can't all fit in 30 KB.
    seedFixtureCatalog(home.path);

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: Array.from({ length: 600 }, (_, i) => ({
        name: `a-fairly-long-and-specific-unresolvable-service-name-number-${i}`,
        evidence: [{ repo: ".", file: `src/service-${i}.ts`, line: i + 1 }],
      })),
      patterns: [],
    };

    const result = await callCommand("validate_profile", { profile }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    const raw = result.text;
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const parsed = JSON.parse(raw) as {
      services: Array<{ name: string; catalogName: string | null }>;
      unresolvedServices: string[];
      truncated: boolean;
      omitted: number;
      hint?: string;
      counts: { services: number; unresolvedServices: number };
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.counts.services).toBe(600); // the true total, not the truncated length
    expect(parsed.counts.unresolvedServices).toBe(600); // every one of them is unresolvable
    expect(parsed.services.length).toBeLessThan(600);
    expect(parsed.omitted).toBe(600 - parsed.services.length);
    expect(parsed.hint).toBeDefined();
    // unresolvedServices must shrink along with services, not stay at the full 600 -- otherwise it
    // alone could still blow the budget even with services itself truncated.
    expect(parsed.unresolvedServices).toHaveLength(parsed.services.length);
    const serviceNames = new Set(parsed.services.map((s) => s.name));
    expect(parsed.unresolvedServices.every((name) => serviceNames.has(name))).toBe(true);
  });

  it("truncates patterns too, not just services, when many long pattern names alone would blow the budget", async () => {
    // reviewer2's finding on the first version of this fix: patterns were never truncated at all,
    // on the assumption a hackathon-scale profile's own pattern list is small by construction. A
    // profile naming few services but many long patterns (as plausible as many long service
    // names -- neither is length-validated, and both are equally the agent's own free text) proved
    // that assumption wrong: patterns alone reached 33,889 bytes at 600 of them, over budget
    // regardless of services being truncated to nothing.
    seedFixtureCatalog(home.path);

    const profile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: ["typescript"] }],
      services: [{ name: "lambda", evidence: [{ repo: ".", file: "a.ts", line: 1 }] }],
      patterns: Array.from({ length: 600 }, (_, i) => ({
        name: `pattern-${"p".repeat(40)}-${i}`,
        evidence: [{ repo: ".", file: `src/pattern-${i}.ts`, line: i + 1 }],
      })),
    };

    const result = await callCommand("validate_profile", { profile }, { storeRoot: home.path });

    expect(result.isError).not.toBe(true);
    const raw = result.text;
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const parsed = JSON.parse(raw) as {
      patterns: string[];
      truncated: boolean;
      omitted: number;
      counts: { services: number; patterns: number };
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.counts.patterns).toBe(600); // the true total, not the truncated length
    expect(parsed.patterns.length).toBeLessThan(600);
  });

  it("rejects a schema-invalid profile, naming the offending entry rather than failing opaquely", async () => {
    seedFixtureCatalog(home.path);

    const invalidProfile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "lambda", evidence: [] }], // no evidence -- schema requires at least one
      patterns: [],
    };

    const result = await callCommand("validate_profile", { profile: invalidProfile }, { storeRoot: home.path });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/lambda/i);
    expect(result.text).toMatch(/evidence/i);
  });

  it("tells the caller to import first when no catalog exists instead of failing opaquely", async () => {
    // No seedFixtureCatalog call -- nothing synced at all.

    const result = await callCommand("validate_profile", { profile: lambdaProfile() }, { storeRoot: home.path });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No catalog has been imported/);
  });
});

