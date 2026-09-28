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
    // exists to prevent, bypassed entirely by re-running install instead. The presence of the
    // manifest is what marks "a previous install by this tool lives here" -- not mere
    // non-emptiness, which would also make the symlink-escape scenario below untestable through
    // this same function (see the next test): a target that's already flagged as installed would
    // refuse before ever reaching the code path that scenario needs to exercise.
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

  it("installs cleanly into a target directory that exists but has no manifest (not a prior install by this tool)", () => {
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "unrelated-file.txt"), "not ours\n");

    const result = installSkill({ sourceDir, targetsDir });

    expect(result.fileCount).toBe(4);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toContain("Body.");
  });

  it("refuses when a destination directory is a symlink escaping the target root, and writes nothing outside it", () => {
    // Reviewer's finding: the lexical resolveWithinRoot check can't see a symlink, since
    // path.resolve never touches the filesystem -- a `reference` symlink pointing outside the
    // target lets every reference/*.md file get written straight through it, outside the intended
    // install directory entirely. No manifest exists yet in this scenario (nothing was installed
    // here before), so the "already installed" refusal above doesn't fire first -- this reaches
    // the real, vulnerable write loop.
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-outside-"));
    try {
      const installedPath = join(targetsDir, SKILL_NAME);
      mkdirSync(installedPath, { recursive: true });
      symlinkSync(outsideDir, join(installedPath, "reference"));

      expect(() => installSkill({ sourceDir, targetsDir })).toThrow();

      // The decisive check: nothing the skill ships (profiling.md, taxonomy.md, workflow.md) ever
      // landed in the real directory the symlink points at.
      expect(readdirSync(outsideDir)).toHaveLength(0);
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
