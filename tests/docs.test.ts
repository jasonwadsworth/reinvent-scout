import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/api/types.js";
import { buildServiceAliasIndex } from "../src/catalog/service-aliases.js";
import { buildProgram } from "../src/cli/main.js";
import { resolveProfile } from "../src/profile/profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const readmePath = join(here, "..", "README.md");
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "fixtures", "catalog-sample.json"), "utf8"),
);

/**
 * Walks a commander program's command tree and returns every full invocation path for a leaf
 * command -- "auth login", "catalog sync" -- not just top-level group names. A naive top-level-only
 * walk would pass this test having documented nothing about `auth login` or `catalog sync`
 * specifically, since "auth" and "catalog" are themselves just grouping commands with no
 * behavior of their own. Commander's auto-added "help" pseudo-command is excluded at every level.
 */
function collectLeafCommandPaths(command: Command, prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const sub of command.commands) {
    if (sub.name() === "help") {
      continue;
    }
    const path = [...prefix, sub.name()];
    if (sub.commands.length === 0) {
      paths.push(path.join(" "));
    } else {
      paths.push(...collectLeafCommandPaths(sub, path));
    }
  }
  return paths;
}

describe("README command coverage", () => {
  it("documents every registered leaf command in a fenced code block", () => {
    const program = buildProgram();
    const commandPaths = collectLeafCommandPaths(program);

    // A sanity check on the test itself: if this ever reports zero commands, every assertion
    // below passes vacuously and the enforcement is silently doing nothing.
    expect(commandPaths.length).toBeGreaterThan(0);

    const readme = readFileSync(readmePath, "utf8");
    const fencedBlocks = [...readme.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]).join("\n");

    for (const path of commandPaths) {
      expect(fencedBlocks).toContain(`reinvent-scout ${path}`);
    }
  });
});

describe("README example profile", () => {
  it("validates and every service resolves against the catalog, so a reader who copies it never hits a schema error", () => {
    const readme = readFileSync(readmePath, "utf8");
    const profileBlocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((match) => JSON.parse(match[1]!) as unknown)
      .filter(
        (parsed): parsed is Record<string, unknown> =>
          typeof parsed === "object" &&
          parsed !== null &&
          "schemaVersion" in parsed &&
          "services" in parsed,
      );

    // A sanity check on the test itself: if the README's example profile is ever reworded out of
    // a ```json fence (or removed), this must fail loudly rather than pass vacuously with nothing
    // left to validate.
    expect(profileBlocks).toHaveLength(1);

    const serviceNames = [...new Set(fixture.flatMap((session) => session.services ?? []))];
    const serviceAliasIndex = buildServiceAliasIndex(serviceNames);

    // resolveProfile itself throws a ZodError for anything schema-invalid (missing evidence, a
    // bad schemaVersion, ...) -- an uncaught throw here already fails this test, which is exactly
    // the "validates" half of this guard. The explicit assertion below is the second half: every
    // service the example names must actually resolve against a real catalog, not just parse.
    const resolved = resolveProfile(profileBlocks[0], serviceAliasIndex);

    expect(resolved.unresolvedServices).toEqual([]);
  });
});
