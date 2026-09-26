import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("CI configuration", () => {
  it("pins the older node matrix entry to the exact engines.node floor, not a resolvable range", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const enginesRange = pkg.engines?.node;
    expect(typeof enginesRange).toBe("string");

    const floorMatch = /^>=(\d+\.\d+\.\d+)$/.exec(enginesRange ?? "");
    expect(
      floorMatch,
      `engines.node ${JSON.stringify(enginesRange)} is not a simple ">=X.Y.Z" floor this test knows how to check`,
    ).not.toBeNull();
    const floor = floorMatch![1]!;

    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "check.yml"), "utf8");
    const matrixLine = /node-version:\s*\[(.*)\]/.exec(workflow);
    expect(matrixLine, "could not find a node-version matrix line in the workflow").not.toBeNull();
    const entries = matrixLine![1]!
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""));

    // A range like "22.x" resolves to whatever the newest 22.x release is at the moment CI runs,
    // not the 22.13.0 floor the package declares -- an API added to Node after that floor would
    // pass CI while breaking exactly the users the floor exists to protect (someone on 22.13.0
    // itself). The matrix entry must be the literal floor version.
    expect(entries).toContain(floor);

    // Checking only that the floor is present would still pass if a loose entry for the floor's
    // own major (e.g. "22.x" alongside "22.13.0") snuck back in beside it -- assert there is at
    // most one loose ".x" entry in the matrix (the current newest major, tracking latest on
    // purpose) and that it is not the floor's own major version.
    const looseEntries = entries.filter((entry) => entry.endsWith(".x"));
    expect(looseEntries.length).toBeLessThanOrEqual(1);
    const floorMajor = floor.split(".")[0];
    expect(looseEntries).not.toContain(`${floorMajor}.x`);
  });
});
