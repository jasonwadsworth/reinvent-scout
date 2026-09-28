import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readPackageVersion } from "../cli/version.js";
import {
  DEFAULT_SKILL_SOURCE_DIR,
  MANIFEST_FILE_NAME,
  SKILL_NAME,
  assertRealPathWithinRoot,
  installSkill,
  listFilesRecursive,
  resolveDefaultSkillsDir,
  resolveWithinRoot,
  sha256Hex,
  type InstallSkillDeps,
  type InstallSkillManifest,
} from "./install.js";

export interface UpdateSkillDeps extends InstallSkillDeps {
  /** Overwrite every locally modified file instead of refusing the whole update. Defaults to
   * `false`. */
  force?: boolean;
}

export type UpdateSkillResult =
  | { status: "up-to-date"; installedPath: string }
  | { status: "fresh-install"; installedPath: string; fileCount: number }
  | { status: "updated"; installedPath: string; updatedFiles: string[]; removedFiles: string[] }
  | { status: "refused"; installedPath: string; modifiedFiles: string[] };

/**
 * Updates an already-installed skill in place, without clobbering a file the user edited locally.
 *
 * No manifest present at the target -- either nothing was ever installed there, or it was copied
 * in some other way -- is treated as a fresh install (delegates to `installSkill` outright, no
 * modified-file check to run against, since there's no prior record to compare against).
 *
 * The installed manifest's own `version` already matching the current package version is reported
 * as `"up-to-date"` with nothing touched at all -- there's nothing new to apply regardless of any
 * local edits.
 *
 * Otherwise, every file the *old* manifest recorded is hashed as it exists on disk right now and
 * compared against the hash recorded at install time. A locally modified file -- a real edit, not
 * this function's own previous write -- refuses the *entire* update (unless `force`), leaving
 * every file, and the manifest itself, byte-for-byte untouched; the refusal names every modified
 * file it found, not just the first one. Under `force`, or when nothing was modified, every file
 * the new source ships is written (overwriting the old content), and any file the old manifest
 * listed that the new source no longer ships is removed -- a real, permanent shape change to the
 * skill's own content, not a leftover.
 */
export function updateSkill(deps: UpdateSkillDeps = {}): UpdateSkillResult {
  const sourceDir = deps.sourceDir ?? DEFAULT_SKILL_SOURCE_DIR;
  const targetsDir = deps.targetsDir ?? resolveDefaultSkillsDir(deps);
  const installedPath = join(targetsDir, SKILL_NAME);
  const newVersion = deps.packageVersion ?? readPackageVersion();
  const force = deps.force ?? false;

  const manifestPath = join(installedPath, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) {
    const result = installSkill(deps);
    return { status: "fresh-install", installedPath: result.installedPath, fileCount: result.fileCount };
  }

  const oldManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as InstallSkillManifest;

  if (oldManifest.version === newVersion) {
    return { status: "up-to-date", installedPath };
  }

  const modifiedFiles: string[] = [];
  for (const [relPath, oldHash] of Object.entries(oldManifest.files)) {
    const filePath = join(installedPath, relPath);
    if (!existsSync(filePath)) {
      // Already gone (removed by hand, or by a previous update) -- nothing left to protect.
      continue;
    }
    if (sha256Hex(readFileSync(filePath)) !== oldHash) {
      modifiedFiles.push(relPath);
    }
  }
  modifiedFiles.sort();

  if (modifiedFiles.length > 0 && !force) {
    return { status: "refused", installedPath, modifiedFiles };
  }

  const newFiles = listFilesRecursive(sourceDir).sort();
  const newFilesSet = new Set(newFiles);
  const newManifestFiles: Record<string, string> = {};

  for (const relPath of newFiles) {
    const destPath = resolveWithinRoot(installedPath, relPath);
    const destParent = dirname(destPath);
    mkdirSync(destParent, { recursive: true });
    assertRealPathWithinRoot(installedPath, destParent);
    const content = readFileSync(join(sourceDir, relPath));
    writeFileSync(destPath, content);
    newManifestFiles[relPath] = sha256Hex(content);
  }

  const removedFiles: string[] = [];
  for (const relPath of Object.keys(oldManifest.files)) {
    if (newFilesSet.has(relPath)) {
      continue;
    }
    const filePath = join(installedPath, relPath);
    if (existsSync(filePath)) {
      rmSync(filePath);
      removedFiles.push(relPath);
    }
  }
  removedFiles.sort();

  const manifest: InstallSkillManifest = { version: newVersion, files: newManifestFiles };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { status: "updated", installedPath, updatedFiles: newFiles, removedFiles };
}
