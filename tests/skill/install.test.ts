import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_FILE_NAME,
  SKILL_NAME,
  SkillAlreadyInstalledError,
  SymlinkEscapeError,
  installSkill,
  resolveDefaultSkillsDir,
  resolveWithinRoot,
  writeSkillFile,
  type InstallSkillManifest,
} from "../../src/skill/install.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("installSkill", () => {
  let sourceDir: string;
  let targetsDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-source-"));
    mkdirSync(join(sourceDir, "reference"));
    writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: reinvent-scout\n---\nBody.\n");
    writeFileSync(join(sourceDir, "reference", "profiling.md"), "Profiling guidance.\n");
    writeFileSync(join(sourceDir, "reference", "taxonomy.md"), "Taxonomy.\n");
    writeFileSync(join(sourceDir, "reference", "workflow.md"), "Workflow.\n");

    targetsDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-target-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetsDir, { recursive: true, force: true });
  });

  it("copies SKILL.md and the reference directory into the target skills directory", () => {
    installSkill({ sourceDir, targetsDir });

    const installedPath = join(targetsDir, SKILL_NAME);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toContain("Body.");
    expect(readFileSync(join(installedPath, "reference", "profiling.md"), "utf8")).toBe(
      "Profiling guidance.\n",
    );
    expect(readFileSync(join(installedPath, "reference", "taxonomy.md"), "utf8")).toBe(
      "Taxonomy.\n",
    );
    expect(readFileSync(join(installedPath, "reference", "workflow.md"), "utf8")).toBe(
      "Workflow.\n",
    );
  });

  it("defaults the target to the claude code skills directory", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "reinvent-scout-fake-home-"));
    try {
      const result = installSkill({ sourceDir, homedir: () => fakeHome });
      expect(result.installedPath).toBe(join(fakeHome, ".claude", "skills", SKILL_NAME));
      expect(existsSync(join(result.installedPath, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("resolveDefaultSkillsDir resolves to ~/.claude/skills for a given homedir", () => {
    expect(resolveDefaultSkillsDir({ homedir: () => "/home/jason" })).toBe(
      "/home/jason/.claude/skills",
    );
  });

  it("installs into an explicit --dir when given, instead of the default", () => {
    const result = installSkill({ sourceDir, targetsDir });
    expect(result.installedPath).toBe(join(targetsDir, SKILL_NAME));
  });

  it("writes an install manifest recording the version and a hash per file", () => {
    installSkill({ sourceDir, targetsDir, packageVersion: "9.9.9" });

    const manifestPath = join(targetsDir, SKILL_NAME, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as InstallSkillManifest;

    expect(manifest.version).toBe("9.9.9");
    expect(manifest.files["SKILL.md"]).toBe(sha256("---\nname: reinvent-scout\n---\nBody.\n"));
    expect(manifest.files["reference/profiling.md"]).toBe(sha256("Profiling guidance.\n"));
    expect(manifest.files["reference/taxonomy.md"]).toBe(sha256("Taxonomy.\n"));
    expect(manifest.files["reference/workflow.md"]).toBe(sha256("Workflow.\n"));
    // The manifest file itself is never a member of its own file list -- it describes the other
    // four files, not itself.
    expect(Object.keys(manifest.files)).toHaveLength(4);
  });

  it("creates the target directory when it does not exist", () => {
    const nested = join(targetsDir, "does", "not", "exist", "yet");
    const result = installSkill({ sourceDir, targetsDir: nested });

    expect(existsSync(result.installedPath)).toBe(true);
    expect(readFileSync(join(result.installedPath, "SKILL.md"), "utf8")).toContain("Body.");
  });

  it("reports the installed path and file count", () => {
    const result = installSkill({ sourceDir, targetsDir });

    expect(result.installedPath).toBe(join(targetsDir, SKILL_NAME));
    expect(result.fileCount).toBe(4);
  });

  it("lists every file under the source directory recursively, including a nested reference subdirectory", () => {
    // Guards against a shallow, non-recursive implementation that only copies top-level files and
    // silently drops everything under reference/ -- readdirSync(dir) without withFileTypes/
    // recursion would still "succeed" on a source dir with only files at the top, so this needs a
    // real nested directory to actually distinguish the two implementations.
    const result = installSkill({ sourceDir, targetsDir });
    expect(result.fileCount).toBe(readdirSync(join(sourceDir, "reference")).length + 1);
  });

  it("refuses to install when a skill is already installed at the target, naming skill update, and leaves it untouched", () => {
    // Reviewer's finding: a second `skill install` silently overwrote a locally-modified SKILL.md
    // with exit 0 and no warning -- exactly what skill update's own modified-file protection
    // exists to prevent, bypassed entirely by re-running install instead.
    installSkill({ sourceDir, targetsDir });
    writeFileSync(
      join(targetsDir, SKILL_NAME, "SKILL.md"),
      "the user's own locally-edited content\n",
    );

    expect(() => installSkill({ sourceDir, targetsDir })).toThrow(SkillAlreadyInstalledError);
    try {
      installSkill({ sourceDir, targetsDir });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/reinvent-scout skill update/);
      // Reviewer's finding: an earlier wording said "add --force" without a command to add it to
      // -- install itself has no --force flag. The full command must be spelled out.
      expect(message).toContain("reinvent-scout skill update --force");
    }

    // Untouched: the locally-edited content is still there, not silently overwritten.
    expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe(
      "the user's own locally-edited content\n",
    );
  });

  it("refuses to install into a target directory holding a hand-copied skill file, even with no manifest at all", () => {
    // Reviewer's repro R6: a hand-copied-and-edited skill directory with no manifest was silently
    // overwritten by the earlier manifest-only check. Keyed on a real conflict -- a file the
    // install is about to write already exists at its destination -- not on the manifest's
    // presence specifically or on the target directory's non-emptiness in general (see
    // `conflictsWithExistingInstall`'s own doc comment for why non-emptiness alone would be too
    // broad, breaking the symlink-escape test below).
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "SKILL.md"), "HAND COPIED + EDITED\n");

    expect(() => installSkill({ sourceDir, targetsDir })).toThrow(SkillAlreadyInstalledError);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toBe("HAND COPIED + EDITED\n");
  });

  it("does not refuse when the target directory holds only an unrelated file the install would never write over", () => {
    // Locks in the deliberately narrower scope: non-emptiness alone is not the condition (see
    // conflictsWithExistingInstall's own doc comment) -- a file this skill's own content never
    // touches is not a real conflict, and install may add its own files alongside it.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "unrelated-file.txt"), "not ours, not a skill file\n");

    const result = installSkill({ sourceDir, targetsDir });

    expect(result.fileCount).toBe(4);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toContain("Body.");
    expect(existsSync(join(installedPath, "unrelated-file.txt"))).toBe(true);
  });

  it("installs cleanly into a target directory that exists but is genuinely empty", () => {
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });

    const result = installSkill({ sourceDir, targetsDir });

    expect(result.fileCount).toBe(4);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toContain("Body.");
  });

  it("refuses when a destination directory is a symlink escaping the target root, and writes nothing outside it (end to end)", () => {
    // Reviewer's own CLI-level repro (R2): a fresh target holding only a symlinked `reference`
    // directory -- no conflicting files, so conflictsWithExistingInstall above doesn't refuse
    // first -- must still reach the write loop's own guard.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(installedPath, { recursive: true });
      symlinkSync(outsideDir, join(installedPath, "reference"));

      expect(() => installSkill({ sourceDir, targetsDir })).toThrow();

      expect(readdirSync(outsideDir)).toHaveLength(0);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses when SKILL.md itself is a dangling symlink escaping the target root, and writes nothing outside it (end to end)", () => {
    // pr-reviewer's finding: conflictsWithExistingInstall uses existsSync, which reports false for
    // a dangling symlink -- so this doesn't refuse first the way the hand-copied-file test above
    // does. SKILL.md sorts first among the skill's own files (uppercase before lowercase), so it's
    // the very first write the loop attempts, and must be the one that trips the guard.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(installedPath, { recursive: true });
      symlinkSync(join(outsideDir, "pwned.md"), join(installedPath, "SKILL.md"));

      expect(() => installSkill({ sourceDir, targetsDir })).toThrow(SymlinkEscapeError);

      // The decisive check: nothing was ever created at the symlink's target.
      expect(existsSync(join(outsideDir, "pwned.md"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses when a nested reference file is a dangling symlink escaping the target root, and writes nothing outside it (end to end)", () => {
    // reviewer2's F4: the same dangling-symlink gap as SKILL.md above, but one level down --
    // proves the guard isn't special-cased to the top-level file the write loop happens to reach
    // first.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(join(installedPath, "reference"), { recursive: true });
      symlinkSync(join(outsideDir, "pwned-profiling.md"), join(installedPath, "reference", "profiling.md"));

      expect(() => installSkill({ sourceDir, targetsDir })).toThrow(SymlinkEscapeError);

      expect(existsSync(join(outsideDir, "pwned-profiling.md"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses atomically: a symlink at the last file processed still leaves nothing written, not even the files sorted before it", () => {
    // pr-reviewer-3's finding, reproduced exactly: a dangling reference/workflow.md symlink (the
    // last file in sorted order -- SKILL.md, reference/profiling.md, reference/taxonomy.md all
    // sort before it) used to leave those three already written, with no manifest, by the time the
    // write loop reached the symlinked one. That left an install that's neither a clean "not
    // installed" (skill install's own conflict check missed it, existsSync being blind to a
    // dangling link) nor a genuine one (skill update calls it "untracked"). Every destination must
    // be checked before any of them is written, so a refusal is always all-or-nothing.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(join(installedPath, "reference"), { recursive: true });
      symlinkSync(join(outsideDir, "pwned-workflow.md"), join(installedPath, "reference", "workflow.md"));

      expect(() => installSkill({ sourceDir, targetsDir })).toThrow(SymlinkEscapeError);

      // The decisive check: none of the files sorted *before* the symlinked one were written --
      // the only thing under installedPath is the pre-existing reference/ directory (holding only
      // the symlink itself, which this call must never touch or remove).
      expect(existsSync(join(installedPath, "SKILL.md"))).toBe(false);
      expect(existsSync(join(installedPath, "reference", "profiling.md"))).toBe(false);
      expect(existsSync(join(installedPath, "reference", "taxonomy.md"))).toBe(false);
      expect(existsSync(join(installedPath, MANIFEST_FILE_NAME))).toBe(false);
      expect(existsSync(join(outsideDir, "pwned-workflow.md"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses when the manifest path itself is a dangling symlink on an otherwise-empty target, and writes nothing outside it (end to end)", () => {
    // reviewer2's F6: conflictsWithExistingInstall checks the manifest with existsSync, which
    // reports false for a dangling symlink -- so an empty target holding only a dangling manifest
    // symlink isn't refused up front either. The manifest write happens last, after every content
    // file, so this proves the guard is reached even then.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(installedPath, { recursive: true });
      symlinkSync(join(outsideDir, "pwned-manifest.json"), join(installedPath, MANIFEST_FILE_NAME));

      expect(() => installSkill({ sourceDir, targetsDir })).toThrow(SymlinkEscapeError);

      expect(existsSync(join(outsideDir, "pwned-manifest.json"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("resolveWithinRoot", () => {
  it("refuses a relative path that resolves outside the given root", () => {
    expect(() => resolveWithinRoot("/some/install/root", "../../etc/passwd")).toThrow();
  });

  it("accepts an ordinary relative path nested inside the root", () => {
    expect(resolveWithinRoot("/some/install/root", "reference/profiling.md")).toBe(
      join("/some/install/root", "reference/profiling.md"),
    );
  });
});

describe("writeSkillFile", () => {
  // installSkill's own "refuses an existing, non-empty target" guard (see above) means a target
  // set up to exercise the symlink-escape scenario below -- which necessarily already contains
  // something, the symlink itself -- can no longer reach installSkill's write loop at all; it's
  // refused first, by design. writeSkillFile is the one function both installSkill's and
  // updateSkill's own write loops actually call (see install.ts's own doc comment on it), so
  // testing it directly here exercises the exact code path each of them runs through, at the
  // point the vulnerability lives -- updateSkill's own end-to-end version of this same scenario
  // (tests/skill/update.test.ts) is still fully reachable, since update always operates on an
  // already-existing install.
  let sourceDir: string;
  let targetsDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-source-"));
    mkdirSync(join(sourceDir, "reference"));
    writeFileSync(join(sourceDir, "profiling.md"), "Profiling guidance.\n");
    writeFileSync(join(sourceDir, "reference", "profiling.md"), "Reference profiling guidance.\n");
    targetsDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-target-"));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetsDir, { recursive: true, force: true });
  });

  it("refuses when the destination's parent directory is a symlink escaping the target root, and writes nothing outside it", () => {
    // Reviewer's finding: the lexical resolveWithinRoot check can't see a symlink, since
    // path.resolve never touches the filesystem -- a `reference` symlink pointing outside the
    // target lets a file meant for `reference/` get written straight through it instead.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(installedPath, { recursive: true });
      symlinkSync(outsideDir, join(installedPath, "reference"));

      expect(() => writeSkillFile(sourceDir, installedPath, "reference/profiling.md")).toThrow();

      // The decisive check: nothing landed in the real directory the symlink points at.
      expect(readdirSync(outsideDir)).toHaveLength(0);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("writes an ordinary file with no symlink involved", () => {
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });

    const hash = writeSkillFile(sourceDir, installedPath, "profiling.md");

    expect(readFileSync(join(installedPath, "profiling.md"), "utf8")).toBe("Profiling guidance.\n");
    expect(hash).toBe(sha256("Profiling guidance.\n"));
  });

  it("replaces an existing destination via rename, not an in-place rewrite -- pr-reviewer-3's finding", () => {
    // Reviewer's finding: nothing at this level distinguished writeFileAtomic's own
    // temp-file-then-rename write from a plain writeFileSync -- both leave the destination holding
    // the right final bytes, so a content-only assertion can't tell them apart. The inode changing
    // is the decisive signal (mirrors tests/core/atomic-write.test.ts's own equivalent check): an
    // in-place rewrite (open the existing path, truncate, write) keeps the same inode, while a
    // rename over the destination always creates a new directory entry pointing at a new inode.
    // This matters here specifically because writeGuardedFile's own comment claims a symlink
    // slipped in between the assertNotSymlink check and the write "can't turn the write into one
    // landing outside the install directory" *because* of the rename -- a claim only a rename-vs-
    // rewrite distinction can actually verify.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeSkillFile(sourceDir, installedPath, "profiling.md");
    const originalInode = statSync(join(installedPath, "profiling.md")).ino;

    writeFileSync(join(sourceDir, "profiling.md"), "Updated profiling guidance.\n");
    writeSkillFile(sourceDir, installedPath, "profiling.md");

    expect(readFileSync(join(installedPath, "profiling.md"), "utf8")).toBe(
      "Updated profiling guidance.\n",
    );
    expect(statSync(join(installedPath, "profiling.md")).ino).not.toBe(originalInode);
  });

  it("refuses when the destination file itself is a dangling symlink, and writes nothing outside it", () => {
    // pr-reviewer's finding: assertRealPathWithinRoot only guards the destination's *parent*
    // directory -- a symlink swapped in for the file itself sails straight through it, and
    // existsSync can't catch it either, since it reports false for a dangling link specifically.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(installedPath, { recursive: true });
      symlinkSync(join(outsideDir, "does-not-exist.md"), join(installedPath, "profiling.md"));

      expect(() => writeSkillFile(sourceDir, installedPath, "profiling.md")).toThrow(
        SymlinkEscapeError,
      );

      expect(readdirSync(outsideDir)).toHaveLength(0);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("leaves no leftover temp file behind after a normal write", () => {
    // Locks in the temp-file-then-rename write: the temp file used to avoid ever following a
    // destination symlink during the write itself must not survive as debris next to the real one.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });

    writeSkillFile(sourceDir, installedPath, "profiling.md");

    expect(readdirSync(installedPath)).toEqual(["profiling.md"]);
  });

  it("reviewer2's ask: creates its temp file inside the destination directory, not elsewhere", () => {
    // Proven without needing to inspect a leftover artifact (there isn't one -- see the cleanup
    // test below): making the destination directory itself read-only fails the temp file's own
    // creation specifically because of destParent's permissions. If the temp file were instead
    // created somewhere else (a system temp directory, say), this directory's permissions
    // wouldn't matter and the write would succeed regardless.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    chmodSync(installedPath, 0o500); // read + execute, no write
    try {
      expect(() => writeSkillFile(sourceDir, installedPath, "profiling.md")).toThrow(
        /EACCES|EPERM/,
      );
    } finally {
      chmodSync(installedPath, 0o700);
    }
  });

  it("cleans up its own temp file when the write fails partway, leaving no debris", () => {
    // Lead's decision, on top of reviewer2's F3/F6/F7 manifest findings: a temp file left behind by
    // a failed write (as opposed to one orphaned by an actual process crash, which no in-process
    // cleanup can ever catch) must not accumulate as junk in the install directory.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    mkdirSync(join(installedPath, "profiling.md")); // occupies the destination, failing the rename

    expect(() => writeSkillFile(sourceDir, installedPath, "profiling.md")).toThrow();

    const leftovers = readdirSync(installedPath).filter((name) => name !== "profiling.md");
    expect(leftovers).toEqual([]);
  });

  it("reviewer2's ask: a leftover temp file from an earlier interrupted process doesn't block a later successful write", () => {
    // Simulates the one kind of leftover no in-process cleanup can prevent -- the process itself
    // killed between the temp write and the rename -- by planting a temp file by hand rather than
    // by making writeSkillFile fail (which now cleans up after itself, per the test above). A fresh
    // write must still succeed, generating its own randomly-named temp file that can't collide with
    // the stale one.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    const staleTempFile = join(installedPath, ".profiling.md.stale-leftover.tmp");
    writeFileSync(staleTempFile, "orphaned by a simulated crash\n");

    const hash = writeSkillFile(sourceDir, installedPath, "profiling.md");

    expect(readFileSync(join(installedPath, "profiling.md"), "utf8")).toBe("Profiling guidance.\n");
    expect(hash).toBe(sha256("Profiling guidance.\n"));
    // The stale leftover is someone else's mess, from a crash this write had no part in -- left
    // alone, not silently swept up as a side effect of an unrelated write.
    expect(readFileSync(staleTempFile, "utf8")).toBe("orphaned by a simulated crash\n");
  });
});
