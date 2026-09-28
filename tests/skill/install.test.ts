import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
      expect((err as Error).message).toMatch(/reinvent-scout skill update/);
    }

    // Untouched: the locally-edited content is still there, not silently overwritten.
    expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe(
      "the user's own locally-edited content\n",
    );
  });

  it("refuses to install into a target directory that exists and is non-empty, even with no manifest at all", () => {
    // Lead's decision, following the reviewer's second repro: keyed on non-emptiness, not the
    // manifest's presence specifically, so a directory with unrelated content -- never installed
    // into by this tool at all -- is refused too, rather than silently written over.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "unrelated-file.txt"), "not ours\n");

    expect(() => installSkill({ sourceDir, targetsDir })).toThrow(SkillAlreadyInstalledError);
    expect(existsSync(join(installedPath, "SKILL.md"))).toBe(false);
  });

  it("installs cleanly into a target directory that exists but is genuinely empty", () => {
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });

    const result = installSkill({ sourceDir, targetsDir });

    expect(result.fileCount).toBe(4);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toContain("Body.");
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
});
