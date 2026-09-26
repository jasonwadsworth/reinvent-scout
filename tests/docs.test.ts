import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const readmePath = join(here, "..", "README.md");

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
