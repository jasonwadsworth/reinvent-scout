import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { formatZodError } from "../cli/zod-errors.js";
import { readPackageVersion } from "../cli/version.js";
import {
  DEFAULT_SKILL_SOURCE_DIR,
  MANIFEST_FILE_NAME,
  SKILL_NAME,
  assertRealPathWithinRoot,
  listFilesRecursive,
  resolveDefaultSkillsDir,
  resolveWithinRoot,
  sha256Hex,
  writeSkillFile,
  type InstallSkillDeps,
  type InstallSkillManifest,
} from "./install.js";

export interface UpdateSkillDeps extends InstallSkillDeps {
  /** Overwrite every locally modified file instead of refusing the whole update. Defaults to
   * `false`. Never bypasses a corrupt or missing manifest -- see `CorruptManifestError` and
   * `SkillNotInstalledError`. */
  force?: boolean;
}

export type UpdateSkillResult =
  | { status: "up-to-date"; installedPath: string }
  | { status: "updated"; installedPath: string; updatedFiles: string[]; removedFiles: string[] }
  | { status: "refused"; installedPath: string; modifiedFiles: string[] };

/**
 * Thrown by `updateSkill` when there's no install manifest at the target -- nothing is installed
 * there at all (the target doesn't exist, or is empty), or something untracked is (a hand-copied
 * skill directory, or any other content this tool never wrote a manifest for). Either way, `update`
 * has no baseline to safely compare against, and update is not install: it never performs a fresh
 * install itself, even when the target is completely empty -- one clear rule, one command that
 * owns bringing a skill onto disk for the first time. Never bypassed by `force`, for the same
 * reason a corrupt manifest isn't: there's no "modified file" to force an overwrite of when there's
 * no prior install to compare against in the first place.
 */
export class SkillNotInstalledError extends Error {
  constructor(installedPath: string) {
    super(
      `No skill is installed at ${installedPath} (no install manifest found). Run ` +
        "`reinvent-scout skill install` first.",
    );
    this.name = "SkillNotInstalledError";
  }
}

/**
 * Thrown when the installed manifest can't be trusted -- either its shape is wrong (unparseable
 * JSON, a missing or mistyped `files` map: reviewer's finding, a bare JS error such as "Cannot
 * convert undefined or null to object" was the entire CLI output for this before), or one of its
 * keys names a path that doesn't actually resolve inside the installed skill's own directory
 * (reviewer's finding: a manifest entry of `"../../victim.txt"` let a `--force` update both read
 * and then delete a file outside the install entirely, since the hash-read and removal loops
 * trusted every key as a plain relative path with no validation).
 *
 * Never bypassed by `force`: `force` overwrites a file this tool's own manifest legitimately
 * tracks as locally modified, not a manifest whose own shape or contents can't be trusted at all --
 * a distinct kind of problem with no correct-but-forced outcome to fall back to. The only remedy
 * is a clean reinstall.
 */
export class CorruptManifestError extends Error {
  constructor(manifestPath: string, reason: string) {
    super(
      `The install manifest at ${manifestPath} is invalid (${reason}). Remove the installed ` +
        "skill directory and run `reinvent-scout skill install` again.",
    );
    this.name = "CorruptManifestError";
  }
}

/** `files` maps a relative path to a lowercase hex sha256 hash (64 hex characters) -- validated
 * strictly, not just "is a string," so a manifest with a truncated or non-hash value is treated as
 * corrupt rather than silently compared against as if it meant something. */
const InstallSkillManifestSchema = z.object({
  version: z.string().min(1),
  files: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/)),
});

/** Reads, shape-validates (via zod) and path-validates an installed manifest, throwing
 * `CorruptManifestError` naming the specific problem for any failure -- malformed JSON, the wrong
 * shape, or a key that doesn't resolve inside `installedPath` (checked lexically via
 * `resolveWithinRoot`, and, when the key's parent directory already exists, also via
 * `assertRealPathWithinRoot` so a symlink swapped in for a tracked subdirectory is caught the same
 * way `writeSkillFile`'s own write-time guard catches one). Nothing in the manifest is trusted
 * for any other purpose -- comparing hashes, reading a file to hash it, or removing a stale one --
 * until every key here has passed.
 */
function readAndValidateManifest(manifestPath: string, installedPath: string): InstallSkillManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new CorruptManifestError(manifestPath, `not valid JSON: ${(err as Error).message}`);
  }

  const parsed = InstallSkillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CorruptManifestError(manifestPath, formatZodError(parsed.error));
  }

  const unsafeKeys: string[] = [];
  for (const relPath of Object.keys(parsed.data.files)) {
    let destPath: string;
    try {
      destPath = resolveWithinRoot(installedPath, relPath);
    } catch {
      unsafeKeys.push(relPath);
      continue;
    }
    const parent = dirname(destPath);
    if (existsSync(parent)) {
      try {
        assertRealPathWithinRoot(installedPath, parent);
      } catch {
        unsafeKeys.push(relPath);
      }
    }
  }
  if (unsafeKeys.length > 0) {
    throw new CorruptManifestError(
      manifestPath,
      `names a path outside the install directory: ${unsafeKeys.join(", ")}`,
    );
  }

  return parsed.data;
}

/**
 * Updates an already-installed skill in place, without clobbering a file the user edited locally.
 *
 * No manifest present at the target throws `SkillNotInstalledError` -- update only ever updates;
 * it never performs a fresh install itself, whether the target is completely empty, doesn't exist,
 * or holds some other untracked content (a hand-copied skill directory, the manifest deleted).
 * `skill install` owns bringing a skill onto disk for the first time, one command, one clear rule.
 *
 * "Up to date" is decided by content, never by the manifest's own `version` field alone: the new
 * source's exact file set and every file's hash must equal the manifest's for nothing to happen.
 * `version` is recorded for informational purposes only -- a hackathon user installing from git at
 * a version number that never changes between commits must still pick up real content changes.
 *
 * Otherwise, two kinds of local file are protected, both refusing the *entire* update (unless
 * `force`) and naming every one found, not just the first: a file the old manifest tracked whose
 * current on-disk hash no longer matches what was recorded (a real edit since install), and a file
 * the new version is *about to start shipping* that already exists on disk under a name the old
 * manifest never tracked at all (a file the user created themselves, which this tool has never
 * touched) -- unless its current bytes already equal what would be written anyway, in which case
 * there's nothing to protect. Under `force`, or when nothing was modified, every file the new
 * source ships is written and any file the old manifest had that the new source no longer ships is
 * removed.
 */
export function updateSkill(deps: UpdateSkillDeps = {}): UpdateSkillResult {
  const sourceDir = deps.sourceDir ?? DEFAULT_SKILL_SOURCE_DIR;
  const targetsDir = deps.targetsDir ?? resolveDefaultSkillsDir(deps);
  const installedPath = join(targetsDir, SKILL_NAME);
  const newVersion = deps.packageVersion ?? readPackageVersion();
  const force = deps.force ?? false;

  const manifestPath = join(installedPath, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) {
    throw new SkillNotInstalledError(installedPath);
  }

  const oldManifest = readAndValidateManifest(manifestPath, installedPath);

  const newFiles = listFilesRecursive(sourceDir).sort();
  const newHashes: Record<string, string> = {};
  for (const relPath of newFiles) {
    newHashes[relPath] = sha256Hex(readFileSync(join(sourceDir, relPath)));
  }

  const oldFileKeys = Object.keys(oldManifest.files).sort();
  const isUpToDate =
    newFiles.length === oldFileKeys.length &&
    newFiles.every((relPath, index) => relPath === oldFileKeys[index]) &&
    newFiles.every((relPath) => oldManifest.files[relPath] === newHashes[relPath]);

  if (isUpToDate) {
    return { status: "up-to-date", installedPath };
  }

  const modifiedFiles = new Set<string>();

  for (const [relPath, oldHash] of Object.entries(oldManifest.files)) {
    const filePath = join(installedPath, relPath);
    if (!existsSync(filePath)) {
      // Already gone (removed by hand, or by a previous update) -- nothing left to protect.
      continue;
    }
    if (sha256Hex(readFileSync(filePath)) !== oldHash) {
      modifiedFiles.add(relPath);
    }
  }

  for (const relPath of newFiles) {
    if (relPath in oldManifest.files) {
      continue; // already checked above
    }
    const filePath = join(installedPath, relPath);
    if (!existsSync(filePath)) {
      continue; // nothing there yet -- safe to write
    }
    if (sha256Hex(readFileSync(filePath)) !== newHashes[relPath]) {
      modifiedFiles.add(relPath);
    }
  }

  if (modifiedFiles.size > 0 && !force) {
    return { status: "refused", installedPath, modifiedFiles: [...modifiedFiles].sort() };
  }

  const newFilesSet = new Set(newFiles);
  const newManifestFiles: Record<string, string> = {};

  for (const relPath of newFiles) {
    newManifestFiles[relPath] = writeSkillFile(sourceDir, installedPath, relPath);
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
