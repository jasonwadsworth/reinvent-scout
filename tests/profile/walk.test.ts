import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkRepo } from "../../src/profile/walk.js";

describe("walkRepo", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reinvent-scout-walk-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, content = ""): void {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  it("skips node_modules, .git, dist, build, .venv, vendor, target and .terraform", () => {
    write("keep.txt", "keep");
    for (const dir of [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".venv",
      "vendor",
      "target",
      ".terraform",
    ]) {
      write(`${dir}/inside.txt`, "should never be seen");
    }

    const result = walkRepo(root);

    expect(result.files.sort()).toEqual(["keep.txt"]);
  });

  it("skips .env files and anything ending in .pem or .key", () => {
    write("keep.txt", "keep");
    write(".env", "SECRET=should-never-be-read");
    write("server.pem", "should never be read");
    write("id.key", "should never be read");

    const result = walkRepo(root);

    expect(result.files.sort()).toEqual(["keep.txt"]);
  });

  it("stops at the configured maximum depth", () => {
    write("level1.txt", "1");
    write("a/level2.txt", "2");
    write("a/b/level3.txt", "3");

    const result = walkRepo(root, { maxDepth: 2 });

    expect(result.files.sort()).toEqual([join("a", "level2.txt"), "level1.txt"]);
  });

  it("stops after the configured maximum file count and reports that it truncated", () => {
    for (let i = 0; i < 5; i++) {
      write(`file-${i}.txt`, String(i));
    }

    const result = walkRepo(root, { maxFiles: 3 });

    expect(result.files).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when nothing was cut off", () => {
    write("only.txt", "content");

    const result = walkRepo(root, { maxFiles: 3 });

    expect(result.files).toEqual(["only.txt"]);
    expect(result.truncated).toBe(false);
  });

  it("skips files above the maximum size", () => {
    write("small.txt", "x".repeat(10));
    write("big.txt", "x".repeat(2000));

    const result = walkRepo(root, { maxFileSizeBytes: 1000 });

    expect(result.files).toEqual(["small.txt"]);
  });

  it("does not follow a symlink that points outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "reinvent-scout-walk-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "should never be seen");
      write("inside.txt", "inside");
      symlinkSync(outside, join(root, "escape"));

      const result = walkRepo(root);

      expect(result.files.sort()).toEqual(["inside.txt"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns paths relative to the root", () => {
    write("top.txt", "top");
    write("nested/deep.txt", "deep");

    const result = walkRepo(root);

    expect(result.files.sort()).toEqual([join("nested", "deep.txt"), "top.txt"]);
  });
});
