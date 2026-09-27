import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registerProfileCommands } from "../../src/cli/commands/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

function seedCatalog(storeRoot: string): void {
  writeCatalog(
    {
      raw: fixture,
      index: fixture.map(buildIndexRecord),
      meta: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        eventId: "reinvent2026",
        syncedAt: 1_700_000_000_000,
        totalCount: fixture.length,
        count: fixture.length,
        includedAbstracts: true,
      },
    },
    { storeRoot },
  );
}

function validProfile(): unknown {
  return {
    schemaVersion: 1,
    repos: [{ root: ".", languages: ["typescript"] }],
    services: [
      { name: "lambda", evidence: [{ repo: ".", file: "src/handler.ts", line: 3 }] },
    ],
    patterns: [],
  };
}

interface Harness {
  run: (args: string[]) => Promise<void>;
  printed: string[];
}

function harness(storeRoot: string): Harness {
  const printed: string[] = [];
  const program = new Command().exitOverride();
  registerProfileCommands(program, {
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

describe("profile validate command", () => {
  let home: TempHome;
  let profileFilePath: string;

  beforeEach(() => {
    home = createTempHome();
    seedCatalog(home.path);
    profileFilePath = join(home.path, "profile.json");
    writeFileSync(profileFilePath, JSON.stringify(validProfile()), "utf8");
  });

  afterEach(() => {
    home.cleanup();
  });

  it("validate prints the resolved profile as compact JSON under --json", async () => {
    const h = harness(home.path);

    await h.run(["profile", "validate", profileFilePath, "--json"]);

    expect(h.printed).toHaveLength(1);
    const parsed = JSON.parse(h.printed[0]!) as { services: Array<{ catalogName: string | null }> };
    expect(parsed.services[0]?.catalogName).toBe("AWS Lambda");
  });

  it("validate lists unresolved service names as a warning in the result, not on stdout", async () => {
    const unresolvedProfile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "sns", evidence: [{ repo: ".", file: "src/notify.ts" }] }],
      patterns: [],
    };
    const path = join(home.path, "unresolved.json");
    writeFileSync(path, JSON.stringify(unresolvedProfile), "utf8");
    const h = harness(home.path);

    await h.run(["profile", "validate", path, "--json"]);

    // Stdout hygiene: exactly one write, and it's the single JSON document -- the warning lives
    // as a field inside it (unresolvedServices), never as a second, separate print call. This
    // matters because part 3's MCP server shares stdout with its protocol stream.
    expect(h.printed).toHaveLength(1);
    const parsed: unknown = JSON.parse(h.printed[0]!);
    expect(parsed).toHaveProperty("unresolvedServices", ["sns"]);
  });

  it("validate exits 1 with the schema error for an invalid file", async () => {
    const invalidProfile = {
      schemaVersion: 1,
      repos: [{ root: ".", languages: [] }],
      services: [{ name: "dynamodb", evidence: [] }],
      patterns: [],
    };
    const path = join(home.path, "invalid.json");
    writeFileSync(path, JSON.stringify(invalidProfile), "utf8");
    const h = harness(home.path);

    await h.run(["profile", "validate", path]);

    // The whole point of the schema's superRefine (see profile.ts) is that the error names the
    // specific offending entry -- the CLI must surface that, not flatten it to a generic message.
    expect(h.printed.join("\n")).toContain('Service "dynamodb" has no evidence');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("validate prefixes each schema error with its field path, so three different missing fields don't print as three identical lines", async () => {
    const missingEverything = { schemaVersion: 1 };
    const path = join(home.path, "missing.json");
    writeFileSync(path, JSON.stringify(missingEverything), "utf8");
    const h = harness(home.path);

    await h.run(["profile", "validate", path]);

    const output = h.printed.join("\n");
    expect(output).toContain("repos:");
    expect(output).toContain("services:");
    expect(output).toContain("patterns:");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("validate reports a clear error, not a stack trace, for a file that isn't valid JSON", async () => {
    const path = join(home.path, "broken.json");
    writeFileSync(path, "{ not valid json", "utf8");
    const h = harness(home.path);

    await h.run(["profile", "validate", path]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("validate rejects a --name that isn't a single safe path segment", async () => {
    const h = harness(home.path);

    await h.run(["profile", "validate", "--name", "../evil"]);

    expect(h.printed.join("\n")).toContain("not a valid profile name");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("validate requires either a file or --name", async () => {
    const h = harness(home.path);

    await h.run(["profile", "validate"]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("profile save command", () => {
  let home: TempHome;
  let profileFilePath: string;

  beforeEach(() => {
    home = createTempHome();
    seedCatalog(home.path);
    profileFilePath = join(home.path, "profile.json");
    writeFileSync(profileFilePath, JSON.stringify(validProfile()), "utf8");
  });

  afterEach(() => {
    home.cleanup();
  });

  it("save stores the profile under the store root by name and validate --name reads it back", async () => {
    const h = harness(home.path);

    await h.run(["profile", "save", "orders-service", "--from", profileFilePath]);

    const savedPath = join(home.path, "profiles", "orders-service.json");
    expect(existsSync(savedPath)).toBe(true);
    expect(statSync(savedPath).mode & 0o777).toBe(0o600);

    const h2 = harness(home.path);
    await h2.run(["profile", "validate", "--name", "orders-service", "--json"]);

    expect(h2.printed).toHaveLength(1);
    const parsed = JSON.parse(h2.printed[0]!) as { services: Array<{ catalogName: string | null }> };
    expect(parsed.services[0]?.catalogName).toBe("AWS Lambda");
  });

  it("save rejects a name that isn't a single safe path segment, and writes nothing", async () => {
    const h = harness(home.path);

    await h.run(["profile", "save", "../../../tmp/evil", "--from", profileFilePath]);

    expect(h.printed.join("\n")).toContain("not a valid profile name");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(existsSync(join(home.path, "profiles"))).toBe(false);
  });

  it("save rejects a schema-invalid profile and writes nothing", async () => {
    const invalidPath = join(home.path, "invalid.json");
    writeFileSync(
      invalidPath,
      JSON.stringify({
        schemaVersion: 1,
        repos: [{ root: ".", languages: [] }],
        services: [{ name: "dynamodb", evidence: [] }],
        patterns: [],
      }),
      "utf8",
    );
    const h = harness(home.path);

    await h.run(["profile", "save", "bad-profile", "--from", invalidPath]);

    expect(h.printed.join("\n")).toContain('Service "dynamodb" has no evidence');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(existsSync(join(home.path, "profiles", "bad-profile.json"))).toBe(false);
  });
});
