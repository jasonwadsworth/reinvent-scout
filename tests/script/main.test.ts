import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registry } from "../../src/commands/registry.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const bundle = join(root, "plugin", "skills", "reinvent-scout", "scripts", "reinvent-scout.mjs");
const fixture: Session[] = JSON.parse(readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"));

describe("the bundled script", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());
  const seed = () => writeCatalog({ raw: fixture, index: fixture.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1_700_000_000_000, totalCount: fixture.length, count: fixture.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  const run = (args: string[], stdin?: string) => {
    const result = spawnSync(process.execPath, [bundle, ...args], { env: { ...process.env, REINVENT_SCOUT_HOME: home.path }, input: stdin ?? "", encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: result.status };
  };

  it("runs a command with --input - and writes exactly one JSON document, exit 0", () => {
    seed();
    const result = run(["list_filters", "--input", "-"], "{}");
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toHaveProperty("fields");
  });
  it("reads --input from a file, and defaults to {}", () => {
    seed();
    const path = join(home.path, "in.json"); writeFileSync(path, JSON.stringify({ field: "venue" }));
    expect(Object.keys(JSON.parse(run(["list_filters", "--input", path]).stdout).fields)).toEqual(["venue"]);
    expect(run(["list_filters"]).code).toBe(0);
  });
  it("reports an unknown command as a usage error, exit 2", () => {
    const result = run(["nope"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: expect.stringContaining("nope") });
  });
  it("reports no command, an unreadable --input and bad JSON as usage errors with no stack trace", () => {
    expect(run([]).code).toBe(2);
    const missing = run(["list_filters", "--input", join(home.path, "absent.json")]);
    expect(missing.code).toBe(2); expect(JSON.parse(missing.stdout)).toHaveProperty("error");
    const bad = run(["list_filters", "--input", "-"], "SECRET-MARKER {not json");
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout)).toHaveProperty("error");
    expect(bad.stdout).not.toContain("SECRET-MARKER");
    expect(bad.stdout).not.toMatch(/\bat .*\(/);
  });
  it("reports a handler error as a command error, exit 1, naming the catalog sync", () => {
    const result = run(["match_sessions", "--input", "-"], JSON.stringify({ profile: { schemaVersion: 1, repos: [{ root: ".", languages: [] }], services: [], patterns: [] } }));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatch(/sync/i);
  });
  it("reports a schema error as a command error with a field path", () => {
    seed();
    const result = run(["list_filters", "--input", "-"], JSON.stringify({ surprise: true }));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toHaveProperty("error");
  });
  it("cuts a very long error to 512 characters, schema errors included", () => {
    seed();
    const rules = Array.from({ length: 300 }, () => ({}));
    const result = run(["map_profile", "--input", "-"], JSON.stringify({ profile: {}, preferences: { rules } }));
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { error: string };
    expect(parsed.error.length).toBeLessThanOrEqual(512);
    expect(parsed.error.length).toBeGreaterThan(400);
  });
  it("--help lists every registry command, --version is package.json's", () => {
    const help = JSON.parse(run(["--help"]).stdout) as { commands: Array<{ name: string }> };
    expect(help.commands.map(command => command.name).sort()).toEqual(Object.keys(registry).sort());
    const version = JSON.parse(run(["--version"]).stdout) as { version: string };
    expect(version.version).toBe((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version);
  });
  it("keeps stdout to a single JSON value across different commands", () => {
    seed();
    for (const [command, input] of [["list_filters", {}], ["get_onsite_preferences", {}], ["validate_profile", { profile: { schemaVersion: 1, repos: [{ root: ".", languages: [] }], services: [], patterns: [] } }]] as const) {
      const result = run([command, "--input", "-"], JSON.stringify(input));
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }
  });
  it("imports nothing from outside node: in the bundle", () => {
    const text = readFileSync(bundle, "utf8");
    const specifiers = [...text.matchAll(/(?:^|\n)\s*import\s[^"']*?from\s*"([^"]+)"|(?:^|\n)\s*import\s*"([^"]+)"/g)].map(match => match[1] ?? match[2]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier.startsWith("node:")).toBe(true);
    expect(text).not.toMatch(/require\(["'](?!node:)/);
  });
});
