import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/core/atomic-write.js";

describe("writeFileAtomic", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = join(tmpdir(), `reinvent-scout-atomic-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    target = join(dir, "data.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file with the requested mode", () => {
    writeFileAtomic(target, () => "hello", { mode: 0o600 });

    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("replaces an existing file atomically without a window at the wrong mode", () => {
    writeFileSync(target, "old", { mode: 0o644 });

    writeFileAtomic(target, () => "new", { mode: 0o600 });

    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    // No leftover temp file in the directory.
    expect(readdirSync(dir)).toEqual(["data.json"]);
  });

  it("leaves the original file intact when serialisation throws", () => {
    writeFileSync(target, "old", { mode: 0o600 });

    expect(() =>
      writeFileAtomic(
        target,
        () => {
          throw new Error("boom");
        },
        { mode: 0o600 },
      ),
    ).toThrow("boom");

    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["data.json"]);
  });
});
