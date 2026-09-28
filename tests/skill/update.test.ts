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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_FILE_NAME, SKILL_NAME, installSkill, type InstallSkillManifest } from "../../src/skill/install.js";
import { updateSkill } from "../../src/skill/update.js";

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

  it("installs cleanly when no manifest is present, treating it as a fresh install", () => {
    const result = updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    expect(result.status).toBe("fresh-install");
    expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe("v1 SKILL body.\n");
    expect(readManifest().version).toBe("1.0.0");
  });

  it("reports already up to date when the installed version matches", () => {
    installSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    const result = updateSkill({ sourceDir: sourceDirV1, targetsDir, packageVersion: "1.0.0" });

    expect(result.status).toBe("up-to-date");
    // Untouched: still the v1 content, not re-copied or re-hashed.
    expect(readFileSync(join(targetsDir, SKILL_NAME, "SKILL.md"), "utf8")).toBe("v1 SKILL body.\n");
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
});
