import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkRepo } from "../../src/profile/walk.js";

const REPOS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "repos");

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
      const secretContent = "should-never-be-seen-outside-secret-marker";
      writeFileSync(join(outside, "secret.txt"), secretContent);
      write("inside.txt", "inside");
      symlinkSync(outside, join(root, "escape"));

      const result = walkRepo(root);

      // Not just that the escape path is absent from the list: read back every file the walk
      // actually returned and confirm the outside file's own content never appears among them --
      // the failure mode that matters is the secret's content reaching a detector, not merely the
      // symlink's name showing up somewhere.
      expect(result.files.sort()).toEqual(["inside.txt"]);
      for (const relPath of result.files) {
        expect(readFileSync(join(root, relPath), "utf8")).not.toContain(secretContent);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not accept a sibling directory whose name merely has the root's name as a prefix", () => {
    // A prefix check on raw strings (`candidate.startsWith(root)`) would wrongly accept
    // "<root>-evil" when root is "<root>", since that string genuinely starts with the root's
    // characters -- the classic way this guard is written wrong. The root itself must be
    // followed by a path separator (or be an exact match) before a candidate counts as "inside".
    const siblingWithOverlappingPrefix = `${root}-evil`;
    mkdirSync(siblingWithOverlappingPrefix, { recursive: true });
    try {
      const secretContent = "should-never-be-seen-sibling-secret-marker";
      writeFileSync(join(siblingWithOverlappingPrefix, "secret.txt"), secretContent);
      write("inside.txt", "inside");
      symlinkSync(siblingWithOverlappingPrefix, join(root, "escape"));

      const result = walkRepo(root);

      expect(result.files.sort()).toEqual(["inside.txt"]);
    } finally {
      rmSync(siblingWithOverlappingPrefix, { recursive: true, force: true });
    }
  });

  it("returns paths relative to the root", () => {
    write("top.txt", "top");
    write("nested/deep.txt", "deep");

    const result = walkRepo(root);

    expect(result.files.sort()).toEqual([join("nested", "deep.txt"), "top.txt"]);
  });
});

describe("walkRepo against the synthetic fixture repos", () => {
  /** Each of task 2's decoys carries a signal that appears nowhere in its repo's legitimate
   * files (see tests/fixtures/repos.test.ts), so a walker that ever descended into one wouldn't
   * just read something -- it would surface a specific, otherwise-impossible marker. Naming that
   * marker here means a regression in the skip logic points at exactly which protection failed,
   * not just that a file count changed. */
  const decoys: Array<{ repo: string; decoyPath: string; marker: string }> = [
    {
      repo: "python-boto3",
      decoyPath: join(".venv", "lib", "decoy.py"),
      marker: "this-should-never-be-detected",
    },
    {
      repo: "terraform-go",
      decoyPath: join(".terraform", "modules", "decoy.tf"),
      marker: "should_never_be_detected",
    },
    {
      repo: "terraform-go",
      decoyPath: join("vendor", "github.com", "aws", "decoy.go"),
      marker: "ShouldNeverBeDetected",
    },
  ];

  it.each(decoys)("excludes the $repo decoy at $decoyPath and its marker from the walk", ({ repo, decoyPath, marker }) => {
    const result = walkRepo(join(REPOS_ROOT, repo));

    expect(result.files).not.toContain(decoyPath);
    for (const relPath of result.files) {
      expect(readFileSync(join(REPOS_ROOT, repo, relPath), "utf8")).not.toContain(marker);
    }
  });

  it("excludes the serverless-ts node_modules decoy and its aws-sdk dependency declaration", () => {
    const result = walkRepo(join(REPOS_ROOT, "serverless-ts"));

    expect(result.files).not.toContain(join("node_modules", "some-package", "package.json"));

    // A plain substring check for "aws-sdk" would wrongly flag the legit package.json too, since
    // its real "@aws-sdk/client-dynamodb" dependency name contains that text -- checking the
    // parsed dependency key, the way a real manifest detector actually would, is what
    // distinguishes the decoy's legacy "aws-sdk" package from the legit v3 modular SDK names.
    for (const relPath of result.files) {
      if (!relPath.endsWith("package.json")) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(join(REPOS_ROOT, "serverless-ts", relPath), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies).not.toHaveProperty("aws-sdk");
    }
  });
});
