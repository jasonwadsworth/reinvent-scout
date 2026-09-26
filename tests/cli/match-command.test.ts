import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { registerMatchCommands } from "../../src/cli/commands/match.js";
import { saveProfileFile } from "../../src/profile/store.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: "reinvent2026",
    syncedAt: 1_700_000_000_000,
    totalCount: fixture.length,
    count: fixture.length,
    includedAbstracts: true,
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

function redshiftProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: [] }],
    services: [{ name: "redshift", evidence: [{ repo: ".", file: "infra/redshift.tf" }] }],
    patterns: [],
  };
}

/** `n` synthetic sessions that all cover AWS Lambda -- unlike the real 60-session fixture (no
 * single service covers more than eight), this lets the default-limit test actually exercise a
 * candidate pool bigger than the default. */
function manyLambdaSessions(n: number): Session[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `synthetic-${i}`,
    abbreviation: `LAM${String(i).padStart(3, "0")}`,
    title: `Serverless deep dive ${i}`,
    services: ["AWS Lambda"],
  }));
}

interface Harness {
  run: (args: string[]) => Promise<void>;
  printed: string[];
}

function harness(storeRoot: string): Harness {
  const printed: string[] = [];
  const program = new Command().exitOverride();
  registerMatchCommands(program, {
    resolveStoreRoot: () => storeRoot,
    print: (message: string) => {
      printed.push(message);
    },
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
  };
}

describe("match command", () => {
  let home: TempHome;
  let profileFilePath: string;

  beforeEach(() => {
    home = createTempHome();
    profileFilePath = join(home.path, "profile.json");
    writeFileSync(profileFilePath, JSON.stringify(lambdaProfile()), "utf8");
  });

  afterEach(() => {
    home.cleanup();
  });

  it("accepts a profile file and prints candidates as compact JSON", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath, "--json"]);

    expect(h.printed).toHaveLength(1);
    const results = JSON.parse(h.printed[0]!) as Array<Record<string, unknown>>;
    expect(results.some((r) => r.abbreviation === "API318")).toBe(true);
    for (const result of results) {
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("reasons");
      // The scorer's own internal term-frequency maps are never agent/user-facing output.
      expect(result).not.toHaveProperty("titleTerms");
      expect(result).not.toHaveProperty("bodyTerms");
    }
  });

  it("accepts a saved profile name instead of a file", async () => {
    seedFixtureCatalog(home.path);
    saveProfileFile("my-lambda-profile", JSON.stringify(lambdaProfile()), { storeRoot: home.path });
    const h = harness(home.path);

    await h.run(["match", "--profile", "my-lambda-profile", "--json"]);

    expect(h.printed).toHaveLength(1);
    const results = JSON.parse(h.printed[0]!) as Array<Record<string, unknown>>;
    expect(results.some((r) => r.abbreviation === "API318")).toBe(true);
  });

  it("rejects a --profile name that isn't a single safe path segment, even though no such file exists", async () => {
    // Same untrusted input, arriving by the "saved name" route instead of the "file path" route --
    // must go through the exact same guard `profile save`/`profile validate --name` already
    // enforce (see profile/store.ts's SAFE_PROFILE_NAME_PATTERN), not a hand-rolled check here that
    // could diverge from it.
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", "../../../etc/passwd-does-not-exist"]);

    expect(h.printed.join("\n")).toContain("not a valid profile name");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("omits abstracts from the output by default", async () => {
    writeFileSync(profileFilePath, JSON.stringify(redshiftProfile()), "utf8");
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath, "--json"]);

    const results = JSON.parse(h.printed[0]!) as Array<Record<string, unknown>>;
    const ant301 = results.find((r) => r.abbreviation === "ANT301");
    expect(ant301).toBeDefined();
    expect(ant301).not.toHaveProperty("abstract");
  });

  it("includes abstracts only under --include-abstracts", async () => {
    writeFileSync(profileFilePath, JSON.stringify(redshiftProfile()), "utf8");
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath, "--json", "--include-abstracts"]);

    const results = JSON.parse(h.printed[0]!) as Array<Record<string, unknown>>;
    const ant301 = results.find((r) => r.abbreviation === "ANT301");
    expect(ant301?.abstract).toBe(fixture.find((s) => s.abbreviation === "ANT301")!.abstract);
  });

  it("defaults to thirty candidates and honours --limit", async () => {
    const sessions = manyLambdaSessions(35);
    writeCatalog(
      {
        raw: sessions,
        index: sessions.map(buildIndexRecord),
        meta: sampleMeta({ totalCount: 35, count: 35 }),
      },
      { storeRoot: home.path },
    );
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath, "--json"]);
    const defaultResults = JSON.parse(h.printed[0]!) as unknown[];
    expect(defaultResults).toHaveLength(30);

    const h2 = harness(home.path);
    await h2.run(["match", "--profile", profileFilePath, "--json", "--limit", "5"]);
    const limitedResults = JSON.parse(h2.printed[0]!) as unknown[];
    expect(limitedResults).toHaveLength(5);
  });

  it("accepts a limit of exactly one hundred", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath, "--json", "--limit", "100"]);

    expect(process.exitCode).not.toBe(1);
    expect(() => JSON.parse(h.printed[0]!)).not.toThrow();
  });

  it("refuses a limit of one hundred and one", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath, "--limit", "101"]);

    expect(h.printed.join("\n")).toContain("--limit");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("prints a human-readable table without --json, including each candidate's reasons", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath]);

    const text = h.printed.join("\n");
    expect(text).toContain("API318");
    // A reason's own explanatory detail (see match/score.ts's Reason.detail) must reach the
    // human-readable form -- the whole point of an "explainable" scorer is wasted if the CLI's
    // table only ever shows a bare number.
    expect(text).toContain("AWS Lambda");
  });

  it("restricts results to the explain lens's level bands when --lens explain is given", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath, "--json", "--lens", "explain"]);

    const results = JSON.parse(h.printed[0]!) as Array<{ levelBand: number | null }>;
    for (const result of results) {
      expect([100, 200]).toContain(result.levelBand);
    }
    // COM320 (Lambda, level band 300) exists in the fixture and must be excluded under this lens.
    expect(
      (JSON.parse(h.printed[0]!) as Array<{ abbreviation: string }>).some(
        (r) => r.abbreviation === "COM320",
      ),
    ).toBe(false);
  });

  it("tells the user to run catalog sync when no catalog is present", async () => {
    const h = harness(home.path);

    await h.run(["match", "--profile", profileFilePath]);

    expect(h.printed.join("\n")).toContain("catalog sync");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
