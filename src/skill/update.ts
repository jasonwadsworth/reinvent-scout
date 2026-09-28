import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { formatZodError } from "../cli/zod-errors.js";
import { readPackageVersion } from "../cli/version.js";
import {
  DEFAULT_SKILL_SOURCE_DIR,
  MANIFEST_FILE_NAME,
  SKILL_NAME,
  SymlinkEscapeError,
  assertNotSymlink,
  assertRealPathWithinRoot,
  listFilesRecursive,
  resolveDefaultSkillsDir,
  resolveWithinRoot,
  sha256Hex,
  writeGuardedFile,
  writeSkillFile,
  type InstallSkillDeps,
  type InstallSkillManifest,
} from "./install.js";

// Re-exported so existing callers importing SymlinkEscapeError from this module (the manifest-key
// validation below still throws it) keep working -- the class itself now lives in install.ts,
// since writeSkillFile's own file-level symlink guard needs to throw it too, and install.ts can't
// import from update.ts without a cycle.
export { SymlinkEscapeError };

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
 * Thrown by `updateSkill` when there's genuinely nothing installed -- the target directory doesn't
 * exist, or exists but is empty. Either way there's nothing here for `update` to update or to
 * adopt, and `update` never performs a fresh install itself (`skill install` owns that, one
 * command, one clear rule). Distinct from `SkillDirectoryUntrackedError` below, which covers a
 * directory that exists *and has content* but no install manifest -- that case has something real
 * for `--force` to adopt; this one doesn't, so `--force` never changes this outcome. Conflating the
 * two into one message sent a user who had just run the suggested remedy back to the same dead end
 * in an earlier version of this check (reviewer's finding).
 */
export class SkillNotInstalledError extends Error {
  constructor(installedPath: string) {
    super(
      `No skill is installed at ${installedPath}. Run \`reinvent-scout skill install\` first.`,
    );
    this.name = "SkillNotInstalledError";
  }
}

/**
 * Thrown by `updateSkill` when the target directory exists *and has content* but no install
 * manifest -- a hand-copied skill directory, or one the manifest was deleted from. `update` has no
 * baseline to compare against, so it refuses by default rather than guessing what's safe to
 * overwrite -- but unlike `SkillNotInstalledError`, there's a real directory here for `update`
 * itself to adopt: `--force` writes every file the skill ships (guarded exactly like an ordinary
 * write), records a fresh manifest, and never touches anything already there that the skill
 * doesn't ship. The message names `--force` directly, since simply re-running `update` without it
 * lands right back here.
 */
export class SkillDirectoryUntrackedError extends Error {
  constructor(installedPath: string) {
    super(
      `Found a skill directory with no install record at ${installedPath}; run ` +
        "`reinvent-scout skill update --force` to replace its files and start tracking them, or " +
        "remove the directory and run `skill install`.",
    );
    this.name = "SkillDirectoryUntrackedError";
  }
}

/**
 * Thrown when the installed manifest can't be trusted -- either its shape is wrong (unparseable
 * JSON, a missing or mistyped `files` map: reviewer's finding, a bare JS error such as "Cannot
 * convert undefined or null to object" was the entire CLI output for this before), or one of its
 * keys names a path that lexically escapes the installed skill's own directory (reviewer's
 * finding: a manifest entry of `"../../victim.txt"` let a `--force` update both read and then
 * delete a file outside the install entirely, since the hash-read and removal loops trusted every
 * key as a plain relative path with no validation) -- a genuinely bad manifest, unlike
 * `SymlinkEscapeError`'s "the manifest is fine, the filesystem isn't."
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

/** Reads, shape-validates (via zod) and path-validates an installed manifest.
 *
 * Two genuinely different failures are kept distinct rather than folded into one "something's
 * wrong with the manifest" message (reviewer's finding on an earlier version of this check, which
 * reported a symlinked `reference/` directory as the manifest itself "naming a path outside the
 * install directory" -- sending a user to inspect the wrong thing entirely):
 *
 * - A key that lexically escapes `installedPath` (`resolveWithinRoot` throws on the key text
 *   alone, before touching the filesystem) is a genuinely bad manifest -- `CorruptManifestError`.
 * - A key whose parent directory *exists* but whose real path (`assertRealPathWithinRoot`) lands
 *   outside `installedPath` means the manifest's own text is fine; a symlink sitting in the
 *   install directory is what's wrong -- `SymlinkEscapeError`, naming the actual escaping
 *   directory (deduplicated -- several tracked files can share one symlinked parent), not the
 *   manifest entries that happen to live under it.
 *
 * Nothing in the manifest is trusted for any other purpose -- comparing hashes, reading a file to
 * hash it, or removing a stale one -- until every key here has passed both checks.
 */
function readAndValidateManifest(manifestPath: string, installedPath: string): InstallSkillManifest {
  // Same reasoning as the content files' own hash-read loops below: reading straight through a
  // symlinked manifest would trust whatever it points at as if it were this install's own record.
  assertNotSymlink(manifestPath, installedPath);
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
  const escapingParents = new Set<string>();
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
        escapingParents.add(parent);
      }
    }
  }
  if (unsafeKeys.length > 0) {
    throw new CorruptManifestError(
      manifestPath,
      `names a path outside the install directory: ${unsafeKeys.join(", ")}`,
    );
  }
  if (escapingParents.size > 0) {
    throw new SymlinkEscapeError([...escapingParents].sort(), installedPath);
  }

  return parsed.data;
}

/**
 * Updates an already-installed skill in place, without clobbering a file the user edited locally.
 *
 * No manifest present at the target is one of two cases, each with its own remedy: genuinely
 * nothing installed -- the target doesn't exist, or exists but is empty (`SkillNotInstalledError`,
 * always -- run `skill install`; `force` changes nothing here, since there's no real content for
 * it to adopt) -- or a directory that exists *with content* but no install record
 * (`SkillDirectoryUntrackedError` unless `force`, which instead *adopts* it -- writes every file
 * the skill ships, guarded exactly like an ordinary write, records a fresh manifest, and never
 * touches anything already there the skill doesn't ship). `update` never performs an *unforced*
 * fresh install of its own -- `skill install` owns that.
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
    if (!existsSync(installedPath) || readdirSync(installedPath).length === 0) {
      // Genuinely nothing installed -- absent or empty. `force` doesn't change this: there's no
      // real content here for it to adopt, so this is never bypassed.
      throw new SkillNotInstalledError(installedPath);
    }
    if (!force) {
      throw new SkillDirectoryUntrackedError(installedPath);
    }
    // Adopt: no prior manifest means no baseline to compare against, so there's nothing to
    // "modify" -- every file the skill ships is written (still guarded by writeSkillFile's own
    // escape check), and a fresh manifest starts tracking them. Anything already in the directory
    // that the skill doesn't ship is left exactly as it is; there's no old manifest to compute a
    // "no longer shipped" removal list from.
    const adoptedFiles = listFilesRecursive(sourceDir).sort();
    const adoptedManifestFiles: Record<string, string> = {};
    for (const relPath of adoptedFiles) {
      adoptedManifestFiles[relPath] = writeSkillFile(sourceDir, installedPath, relPath);
    }
    const adoptedManifest: InstallSkillManifest = { version: newVersion, files: adoptedManifestFiles };
    writeGuardedFile(manifestPath, installedPath, JSON.stringify(adoptedManifest, null, 2));
    return { status: "updated", installedPath, updatedFiles: adoptedFiles, removedFiles: [] };
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
    // Checked before existsSync, and unconditionally: existsSync follows a symlink and reports
    // false for a dangling one specifically, which would otherwise skip straight past this file as
    // "already gone" while assertNotSymlink still needs to see -- and refuse on -- it either way.
    assertNotSymlink(filePath, installedPath);
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
    assertNotSymlink(filePath, installedPath);
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
  writeGuardedFile(manifestPath, installedPath, JSON.stringify(manifest, null, 2));

  return { status: "updated", installedPath, updatedFiles: newFiles, removedFiles };
}
