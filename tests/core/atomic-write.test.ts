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
    const originalInode = statSync(target).ino;

    writeFileAtomic(target, () => "new", { mode: 0o600 });

    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    // No leftover temp file in the directory.
    expect(readdirSync(dir)).toEqual(["data.json"]);
    // The path was replaced by a rename of a fully-written, already-chmod'd temp file rather
    // than truncated and rewritten in place -- proven by the inode changing. An in-place
    // rewrite (open + truncate + write on the existing path) would keep the same inode and
    // would also reopen a window where a concurrent reader could observe a partial write or
    // the pre-chmod mode; this assertion catches a regression to that approach even though it
    // can still produce the right final bytes and mode.
    expect(statSync(target).ino).not.toBe(originalInode);
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
