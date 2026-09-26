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
    const floor = floorMatch![1];

    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "check.yml"), "utf8");

    // A range like "22.x" resolves to whatever the newest 22.x release is at the moment CI runs,
    // not the 22.13.0 floor the package declares -- an API added to Node after that floor would
    // pass CI while breaking exactly the users the floor exists to protect (someone on 22.13.0
    // itself). The matrix entry must be the literal floor version.
    expect(workflow).toContain(`"${floor}"`);
    expect(workflow).not.toMatch(/["']22\.x["']/);
  });
});
