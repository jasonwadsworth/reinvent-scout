import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPackageVersion } from "../../src/cli/version.js";

describe("readPackageVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reinvent-scout-version-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the version field from the given package.json", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ version: "1.2.3" }));

    expect(readPackageVersion({ packageJsonPath: path })).toBe("1.2.3");
  });

  it("throws a clear error when the version field is missing", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ name: "no-version-here" }));

    expect(() => readPackageVersion({ packageJsonPath: path })).toThrow(
      /version/i,
    );
  });

  it("throws a clear error when the version field is not a string", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ version: 123 }));

    expect(() => readPackageVersion({ packageJsonPath: path })).toThrow(
      /version/i,
    );
  });

  it("throws a clear error when the file is not valid JSON", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, "{ not valid json");

    expect(() => readPackageVersion({ packageJsonPath: path })).toThrow();
  });
});
