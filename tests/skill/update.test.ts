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
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_FILE_NAME, SKILL_NAME, installSkill, type InstallSkillManifest } from "../../src/skill/install.js";
import {
  CorruptManifestError,
  SkillDirectoryUntrackedError,
  SkillNotInstalledError,
  SymlinkEscapeError,
  updateSkill,
} from "../../src/skill/update.js";

describe("updateSkill", () => {
  let sourceDirV1: string;
  let sourceDirV2: string;
  let targetsDir: string;

  beforeEach(() => {
    sourceDirV1 = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-v1-"));
    mkdirSync(join(sourceDirV1, "reference"));
    writeFileSync(join(sourceDirV1, "SKILL.md"), "v1 SKILL body.\n");
    writeFileSync(join(sourceDirV1, "reference", "profiling.md"), "v1 profiling.\n");
    writeFileSync(join(sourceDirV1, "reference", "taxonomy.md"), "v1 taxonomy.\n");

    sourceDirV2 = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-v2-"));
    mkdirSync(join(sourceDirV2, "reference"));
    writeFileSync(join(sourceDirV2, "SKILL.md"), "v2 SKILL body.\n");
    writeFileSync(join(sourceDirV2, "reference", "profiling.md"), "v2 profiling.\n");
    // taxonomy.md is deliberately dropped in v2 -- the new source no longer ships it, exercising
    // the "remove a file the new version no longer ships" path.

    targetsDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-target-"));
  });

  afterEach(() => {
    rmSync(sourceDirV1, { recursive: true, force: true });
    rmSync(sourceDirV2, { recursive: true, force: true });
    rmSync(targetsDir, { recursive: true, force: true });
  });

  function readManifest(): InstallSkillManifest {
    return JSON.parse(
      readFileSync(join(targetsDir, SKILL_NAME, MANIFEST_FILE_NAME), "utf8"),
    ) as InstallSkillManifest;
  }

  it("refuses when no manifest is present at all, naming skill install -- update never installs", () => {
    // Lead's decision: update only ever updates, whether the target doesn't exist, is empty, or
    // holds untracked content -- one clear rule, no silent "fresh install" branch to distinguish
    // from an update that lost track of its own baseline.
    expect(() =>
      updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" }),
    ).toThrow(SkillNotInstalledError);
    expect(existsSync(join(targetsDir, SKILL_NAME))).toBe(false);
  });

  it("refuses when the target exists with content but no install record, naming --force as the remedy", () => {
    // Distinct from the "directory absent" case above: there's real content here, so the remedy is
    // different (--force to adopt it, not `skill install`) -- reviewer's finding that an earlier
    // version of this message routed both cases through install's own "already exists" wording,
    // telling a user who had just run `update --force` to run `update --force`.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "SKILL.md"), "HAND COPIED, no manifest\n");

    expect(() =>
      updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" }),
    ).toThrow(SkillDirectoryUntrackedError);
    let message = "";
    try {
      updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/--force/);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toBe(
      "HAND COPIED, no manifest\n",
    );
  });

  it("refuses an empty target directory naming skill install, even under --force -- there's nothing for force to adopt", () => {
    // Lead's decision: "nothing installed" (absent or empty) always means `skill install`, never
    // `--force` -- force only ever adopts a directory that actually has content in it.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });

    expect(() =>
      updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0", force: true }),
    ).toThrow(SkillNotInstalledError);
    expect(readdirSync(installedPath)).toHaveLength(0);
  });

  it("adopts an untracked target directory with content under --force, writing every shipped file and a fresh manifest", () => {
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "SKILL.md"), "HAND COPIED, no manifest\n");

    const result = updateSkill({
      sourceDir: sourceDirV1,
      targetsDir,
      packageVersion: "1.0.0",
      force: true,
    });

    expect(result.status).toBe("updated");
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toBe("v1 SKILL body.\n");
    expect(readManifest().version).toBe("1.0.0");
    // Following the remedy actually works: a plain update call afterward reports up to date.
    expect(
      updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" }).status,
    ).toBe("up-to-date");
  });

  it("adopts a hand-copied, untracked target directory under --force, overwriting its shipped files but leaving unrelated ones alone", () => {
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(join(installedPath, "reference"), { recursive: true });
    writeFileSync(join(installedPath, "SKILL.md"), "HAND COPIED, no manifest\n");
    writeFileSync(join(installedPath, "unrelated.txt"), "not a skill file\n");

    const result = updateSkill({
      sourceDir: sourceDirV1,
      targetsDir,
      packageVersion: "1.0.0",
      force: true,
    });

    expect(result.status).toBe("updated");
    // Overwritten: the skill's own shipped file.
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toBe("v1 SKILL body.\n");
    // Untouched: a file the skill doesn't ship at all.
    expect(readFileSync(join(installedPath, "unrelated.txt"), "utf8")).toBe(
      "not a skill file\n",
    );
  });

  it("reports already up to date when the installed content matches", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    const result = updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    expect(result.status).toBe("up-to-date");
    // Untouched: still the v1 content, not re-copied or re-hashed.
    expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe("v1 SKILL body.\n");
  });

  it("updates even when the version is unchanged, if the source content changed", () => {
    // Lead's decision: package.json can sit at one version through many SKILL.md edits on this
    // branch, and a hackathon user installs straight from git -- version alone would report
    // "already up to date" and never apply a real content change. "Up to date" is decided by the
    // new source's exact file set and hashes matching the manifest's, not by version.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    const sourceDirSameVersionNewContent = mkdtempSync(
      join(tmpdir(), "reinvent-scout-skill-same-version-"),
    );
    try {
      mkdirSync(join(sourceDirSameVersionNewContent, "reference"));
      writeFileSync(join(sourceDirSameVersionNewContent, "SKILL.md"), "NEW flow, same version.\n");
      writeFileSync(
        join(sourceDirSameVersionNewContent, "reference", "profiling.md"),
        "v1 profiling.\n",
      );
      writeFileSync(
        join(sourceDirSameVersionNewContent, "reference", "taxonomy.md"),
        "v1 taxonomy.\n",
      );

      const result = updateSkill({
        sourceDir: sourceDirSameVersionNewContent,
        targetsDir,
        packageVersion: "1.0.0", // deliberately the same version as the install above
      });

      expect(result.status).toBe("updated");
      expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe(
        "NEW flow, same version.\n",
      );
    } finally {
      rmSync(sourceDirSameVersionNewContent, { recursive: true, force: true });
    }
  });

  it("overwrites files whose hash matches the manifest", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    const result = updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0" });

    expect(result.status).toBe("updated");
    expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe("v2 SKILL body.\n");
    expect(readFileSync(join(targetsDir, SKILL_NAME, "reference", "profiling.md"), "utf8")).toBe(
      "v2 profiling.\n",
    );
    expect(readManifest().version).toBe("2.0.0");
  });

  it("removes a file that the new version no longer ships, when it is unmodified", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    expect(existsSync(join(targetsDir, SKILL_NAME, "reference", "taxonomy.md"))).toBe(true);

    const result = updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0" });

    expect(result.status).toBe("updated");
    expect(existsSync(join(targetsDir, SKILL_NAME, "reference", "taxonomy.md"))).toBe(false);
    expect(readManifest().files["reference/taxonomy.md"]).toBeUndefined();
  });

  it("refuses to overwrite a locally modified file and names it", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    writeFileSync(
      join(targetsDir, SKILL_NAME, "reference", "profiling.md"),
      "locally edited by the user\n",
    );

    const result = updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0" });

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.modifiedFiles).toEqual(["reference/profiling.md"]);
    }
  });

  it("leaves the install untouched when it refuses", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    writeFileSync(
      join(targetsDir, SKILL_NAME, "reference", "profiling.md"),
      "locally edited by the user\n",
    );
    const manifestBefore = readFileSync(join(targetsDir, SKILL_NAME, MANIFEST_FILE_NAME), "utf8");
    const skillMdBefore = readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8");

    updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0" });

    // Nothing changed: not the manifest, not the untouched SKILL.md, not even the file that
    // triggered the refusal (still the locally-edited content, not overwritten and not reverted).
    expect(readFileSync(join(targetsDir, SKILL_NAME, MANIFEST_FILE_NAME), "utf8")).toBe(
      manifestBefore,
    );
    expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe(skillMdBefore);
    expect(readFileSync(join(targetsDir, SKILL_NAME, "reference", "profiling.md"), "utf8")).toBe(
      "locally edited by the user\n",
    );
    // taxonomy.md would be removed by a real update (v2 drops it) -- a refusal must not do that
    // either.
    expect(existsSync(join(targetsDir, SKILL_NAME, "reference", "taxonomy.md"))).toBe(true);
  });

  it("overwrites a locally modified file under --force", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    writeFileSync(
      join(targetsDir, SKILL_NAME, "reference", "profiling.md"),
      "locally edited by the user\n",
    );

    const result = updateSkill({
      sourceDir: sourceDirV2,
      targetsDir,
      packageVersion: "2.0.0",
      force: true,
    });

    expect(result.status).toBe("updated");
    expect(readFileSync(join(targetsDir, SKILL_NAME, "reference", "profiling.md"), "utf8")).toBe(
      "v2 profiling.\n",
    );
    expect(readManifest().version).toBe("2.0.0");
  });

  it("refuses when a destination directory is a symlink escaping the target root, and writes nothing outside it", () => {
    // Same real vulnerability as installSkill's own write loop (reviewer's finding), reached here
    // through update instead of install: swap the installed reference/ directory for a symlink
    // before updating. The old manifest's own reference/*.md entries no longer exist AT that
    // (symlinked, empty) location, so the modified-file scan treats them as "already gone" and
    // doesn't refuse for that reason -- this update proceeds into the real write loop, which is
    // exactly what needs to refuse instead.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-update-outside-"));
    try {
      rmSync(join(targetsDir, SKILL_NAME, "reference"), { recursive: true, force: true });
      symlinkSync(outsideDir, join(targetsDir, SKILL_NAME, "reference"));

      expect(() =>
        updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0" }),
      ).toThrow();

      // The decisive check: none of the new version's reference/*.md content landed in the real
      // directory the symlink points at.
      expect(readdirSync(outsideDir)).toHaveLength(0);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses when a new version starts shipping a path the user already has, untracked, on disk", () => {
    // Reviewer's finding: the old manifest only protects paths it already knew about -- a file the
    // user created themselves (never installed by this tool, so never in any manifest) gets
    // silently overwritten the moment a new version happens to start shipping that same path.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    writeFileSync(
      join(targetsDir, SKILL_NAME, "reference", "notes.md"),
      "USER'S OWN NOTES, never installed by this tool\n",
    );

    const sourceDirV3 = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-v3-"));
    try {
      mkdirSync(join(sourceDirV3, "reference"));
      writeFileSync(join(sourceDirV3, "SKILL.md"), "v3 SKILL body.\n");
      writeFileSync(join(sourceDirV3, "reference", "profiling.md"), "v3 profiling.\n");
      writeFileSync(join(sourceDirV3, "reference", "taxonomy.md"), "v3 taxonomy.\n");
      // v3 now ships reference/notes.md too -- exactly the path the user's own file already
      // occupies, with different content.
      writeFileSync(join(sourceDirV3, "reference", "notes.md"), "shipped notes content\n");

      const result = updateSkill({ sourceDir: sourceDirV3, targetsDir, packageVersion: "3.0.0" });

      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.modifiedFiles).toEqual(["reference/notes.md"]);
      }
      expect(readFileSync(join(targetsDir, SKILL_NAME, "reference", "notes.md"), "utf8")).toBe(
        "USER'S OWN NOTES, never installed by this tool\n",
      );

      const forced = updateSkill({
        sourceDir: sourceDirV3,
        targetsDir,
        packageVersion: "3.0.0",
        force: true,
      });
      expect(forced.status).toBe("updated");
      expect(readFileSync(join(targetsDir, SKILL_NAME, "reference", "notes.md"), "utf8")).toBe(
        "shipped notes content\n",
      );
    } finally {
      rmSync(sourceDirV3, { recursive: true, force: true });
    }
  });

  it("does not refuse when an untracked on-disk file already has the exact bytes the new version would write", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    writeFileSync(join(targetsDir, SKILL_NAME, "reference", "notes.md"), "identical content\n");

    const sourceDirV3 = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-v3-identical-"));
    try {
      mkdirSync(join(sourceDirV3, "reference"));
      writeFileSync(join(sourceDirV3, "SKILL.md"), "v3 SKILL body.\n");
      writeFileSync(join(sourceDirV3, "reference", "profiling.md"), "v3 profiling.\n");
      writeFileSync(join(sourceDirV3, "reference", "taxonomy.md"), "v3 taxonomy.\n");
      writeFileSync(join(sourceDirV3, "reference", "notes.md"), "identical content\n");

      const result = updateSkill({ sourceDir: sourceDirV3, targetsDir, packageVersion: "3.0.0" });

      expect(result.status).toBe("updated");
    } finally {
      rmSync(sourceDirV3, { recursive: true, force: true });
    }
  });

  it("refuses the entire update, deleting nothing, when a manifest key resolves outside the install directory, even under --force", () => {
    // Reviewer's finding: a hand-edited or corrupted manifest entry of "../../victim.txt" let a
    // --force update both read (as a "modified" check) and then delete a file outside the install
    // entirely -- the removal loop trusted every manifest key as a plain relative path.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    const victimDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-victim-"));
    try {
      const victimPath = join(victimDir, "victim.txt");
      writeFileSync(victimPath, "please do not delete me\n");

      const installedPath = join(targetsDir, SKILL_NAME);
      const manifestPath = join(installedPath, MANIFEST_FILE_NAME);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as InstallSkillManifest;
      // A genuine relative path from the install directory to the victim file, using ".."
      // segments -- exactly the shape a real escaping manifest entry takes. 64 hex characters, a
      // well-shaped-but-meaningless hash so shape validation alone doesn't already reject it.
      const relativeToVictim = relative(installedPath, victimPath);
      manifest.files[relativeToVictim] = "0".repeat(64);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      expect(() =>
        updateSkill({
          sourceDir: sourceDirV2,
          targetsDir,
          packageVersion: "2.0.0",
          force: true,
        }),
      ).toThrow(CorruptManifestError);

      // The decisive check: the victim file, entirely outside the install directory, still exists
      // with its original content -- force must not reach it at all.
      expect(existsSync(victimPath)).toBe(true);
      expect(readFileSync(victimPath, "utf8")).toBe("please do not delete me\n");
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  it("refuses when a manifest key is an absolute path, even one that happens not to exist", () => {
    // Reviewer's specific follow-up: an absolute key like "/etc/hosts" must be rejected on its own
    // terms, not merely "happen to be harmless" because the path it names isn't reachable or
    // doesn't get removed for unrelated reasons.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    const manifestPath = join(targetsDir, SKILL_NAME, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as InstallSkillManifest;
    manifest.files["/etc/hosts"] = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(() =>
      updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0", force: true }),
    ).toThrow(CorruptManifestError);
  });

  it("refuses cleanly, naming the manifest path, when the manifest is corrupt rather than crashing with a bare error", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    const manifestPath = join(targetsDir, SKILL_NAME, MANIFEST_FILE_NAME);
    // Missing the required `files` map entirely.
    writeFileSync(manifestPath, JSON.stringify({ version: "1.0.0" }));

    let thrown: unknown;
    try {
      updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CorruptManifestError);
    expect((thrown as Error).message).toContain(manifestPath);
  });

  it("refuses when no manifest exists but the target is non-empty, leaving the hand edit untouched", () => {
    // Reviewer's finding: a deleted (or never-written) manifest over an otherwise-populated
    // install directory was treated as safe to silently "fresh install" over, losing a hand edit
    // the same way a second `skill install` did before that was fixed.
    const installedPath = join(targetsDir, SKILL_NAME);
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "SKILL.md"), "HAND EDITED, no manifest present\n");

    expect(() =>
      updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" }),
    ).toThrow(SkillDirectoryUntrackedError);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toBe(
      "HAND EDITED, no manifest present\n",
    );
  });

  it("distinguishes a symlink-caused escape from a genuinely corrupt manifest, naming the symlinked directory", () => {
    // Reviewer's finding (R2b's diagnosis, non-blocking): the first version of this check reported
    // a symlinked reference/ directory as the manifest itself "naming a path outside the install
    // directory" -- correct refusal, wrong explanation, sending a user to inspect their manifest
    // instead of the actual symlink.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    const installedPath = join(targetsDir, SKILL_NAME);
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-symlink-diag-"));
    try {
      rmSync(join(installedPath, "reference"), { recursive: true, force: true });
      symlinkSync(outsideDir, join(installedPath, "reference"));

      let thrown: unknown;
      try {
        updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0", force: true });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SymlinkEscapeError);
      const message = (thrown as Error).message;
      expect(message).toContain(join(installedPath, "reference"));
      expect(message).toMatch(/symlink/i);
      expect(message).not.toMatch(/manifest/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses as a symlink escape, not a false 'modified locally', when an installed file is swapped for a symlink without --force", () => {
    // pr-reviewer's finding, isolated to the read-only path specifically: without --force,
    // updateSkill never reaches writeSkillFile's own write-time guard at all (a modified file
    // refuses the whole update before any write is attempted), so this scenario can only be caught
    // by lstat'ing the destination in the hash-read loop itself -- reading straight through the
    // symlink to hash whatever it points at would otherwise misdiagnose this as an ordinary local
    // edit ("modified locally") rather than the symlink it actually is.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    const installedPath = join(targetsDir, SKILL_NAME);
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-file-symlink-nf-"));
    try {
      const outsideFile = join(outsideDir, "victim.md");
      writeFileSync(outsideFile, "victim content, must never be touched\n");
      rmSync(join(installedPath, "SKILL.md"));
      symlinkSync(outsideFile, join(installedPath, "SKILL.md"));

      expect(() =>
        updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0" }),
      ).toThrow(SymlinkEscapeError);

      expect(readFileSync(outsideFile, "utf8")).toBe("victim content, must never be touched\n");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses when an installed file itself is a symlink escaping the target root, even under --force, and writes nothing outside it", () => {
    // pr-reviewer's finding: the parent-directory-only guard let SKILL.md itself be swapped for a
    // symlink to an outside file. A plain update misdiagnosed this as "modified locally" (it read
    // straight through the link to hash the *outside* file's content against the recorded hash),
    // and --force then overwrote that outside file with the new SKILL.md content. lstat'ing the
    // destination itself, before any hash read, must catch this regardless of --force -- force
    // overwrites content this tool tracks, not a symlink pointing somewhere else entirely.
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });
    const installedPath = join(targetsDir, SKILL_NAME);
    const outsideDir = mkdtempSync(join(tmpdir(), "reinvent-scout-skill-file-symlink-"));
    try {
      const outsideFile = join(outsideDir, "victim.md");
      writeFileSync(outsideFile, "victim content, must never be touched\n");
      rmSync(join(installedPath, "SKILL.md"));
      symlinkSync(outsideFile, join(installedPath, "SKILL.md"));

      expect(() =>
        updateSkill({ sourceDir: sourceDirV2, targetsDir, packageVersion: "2.0.0", force: true }),
      ).toThrow(SymlinkEscapeError);

      expect(readFileSync(outsideFile, "utf8")).toBe("victim content, must never be touched\n");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
