import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageVersion } from "../cli/version.js";

/** The name this skill installs under, and the one name `skill update` (task 9) looks for --
 * matches the source directory name, `skills/reinvent-scout`, and the product name everywhere
 * else (amendment 5: "the skill directory `skills/reinvent-scout/`"). */
export const SKILL_NAME = "reinvent-scout";

/** Written inside the installed skill's own directory, alongside `SKILL.md` -- never inside the
 * source tree, so it can never be mistaken for one of the skill's own content files. */
export const MANIFEST_FILE_NAME = ".install-manifest.json";

const here = dirname(fileURLToPath(import.meta.url));
/** This module compiles to `dist/skill/install.js`; the skill's own content ships at the package
 * root's `skills/reinvent-scout` (see `package.json`'s `files` list), two levels up from
 * `dist/skill`. Mirrors `cli/version.ts`'s own `defaultPackageJsonPath` convention exactly.
 * Exported so `skill/update.ts` shares the exact same default, rather than recomputing it. */
export const DEFAULT_SKILL_SOURCE_DIR = join(here, "..", "..", "skills", SKILL_NAME);

export interface InstallSkillManifest {
  version: string;
  /** Relative path (POSIX-style, `/`-separated regardless of platform) to a lowercase hex sha256
   * hash of that file's exact bytes at install time -- `skill update`'s own modified-file
   * protection (task 9) compares a locally-installed file's current hash against this to tell an
   * untouched file from one the user has edited since installing. */
  files: Record<string, string>;
}

export interface InstallSkillDeps {
  /** Defaults to this package's own bundled `skills/reinvent-scout` directory. Inject a fixture
   * directory in tests so nothing here depends on the built skill content actually matching. */
  sourceDir?: string;
  /** The skills directory to install into -- the skill itself is written to
   * `<targetsDir>/reinvent-scout`. Defaults to `resolveDefaultSkillsDir()` (`~/.claude/skills`). */
  targetsDir?: string;
  /** Defaults to `os.homedir`. Only consulted when `targetsDir` is not given. */
  homedir?: () => string;
  /** Defaults to this package's own real version (`readPackageVersion`). Inject a fixed string in
   * tests so the manifest's `version` field doesn't depend on this repo's own `package.json`. */
  packageVersion?: string;
}

export interface InstallSkillResult {
  installedPath: string;
  /** The number of skill content files installed -- never counts the manifest file itself, which
   * describes those files rather than being one of them. */
  fileCount: number;
}

/**
 * Thrown by `installSkill` when installing would conflict with something already at the target --
 * see `conflictsWithExistingInstall` for exactly what counts. A previous install (or a hand-copied
 * skill directory) already lives here, so blindly writing over it would silently destroy whatever
 * the user has there, manifest or not. Reviewer's findings, both closed by this: re-running `skill
 * install` (the obvious thing to try after upgrading) lost a locally-modified `SKILL.md` with exit
 * 0; separately, a hand-copied-and-edited skill directory with no manifest at all was overwritten
 * the same way, since the original fix was keyed on the manifest's presence specifically. `skill
 * update` owns every legitimate overwrite decision on an existing install from here on -- its own
 * modified-file protection is the only path that may touch one; `skill install` refuses outright
 * rather than guessing.
 */
export class SkillAlreadyInstalledError extends Error {
  constructor(installedPath: string) {
    super(
      `A skill (or a conflicting file) already exists at ${installedPath}. Run ` +
        "`reinvent-scout skill update` instead, or `reinvent-scout skill update --force` to " +
        "overwrite local edits.",
    );
    this.name = "SkillAlreadyInstalledError";
  }
}

/**
 * True when installing `relativeFiles` into `installedPath` would conflict with something already
 * there -- the manifest already exists (a previous install by this tool), or any individual file
 * the install is *about to write* already exists at its destination (a hand-copied, or otherwise
 * not-installed-by-this-tool, skill directory). This is deliberately not "the target directory is
 * non-empty": an *unrelated* file that happens to already be there, but that installing this skill
 * would never write over, is not a real conflict, and treating it as one would also make an empty-
 * of-conflicting-files target holding only a symlinked `reference` directory (no files under it at
 * all) impossible to reach `installSkill`'s own write loop through, defeating the point of testing
 * the symlink-escape guard end to end via `installSkill` itself, not just `writeSkillFile` alone.
 */
export function conflictsWithExistingInstall(
  installedPath: string,
  relativeFiles: readonly string[],
): boolean {
  if (existsSync(join(installedPath, MANIFEST_FILE_NAME))) {
    return true;
  }
  return relativeFiles.some((relPath) => existsSync(join(installedPath, relPath)));
}

/** The Claude Code default: `~/.claude/skills`. `--dir <path>` (the CLI's own flag) covers Kiro
 * and any other agent whose skills directory can't be guessed from here -- see the plan's own
 * "Kiro skill directory is not guessed" decision. */
export function resolveDefaultSkillsDir(deps: Pick<InstallSkillDeps, "homedir"> = {}): string {
  const homedir = deps.homedir ?? osHomedir;
  return join(homedir(), ".claude", "skills");
}

/**
 * Resolves `relativePath` under `root` and refuses (throws) when the result would not actually
 * land inside `root` -- a "zip slip"-shaped defense against a relative path carrying `..`
 * segments ever writing outside the intended install directory. This package's own bundled skill
 * content can't naturally produce such a path today (a real directory listing never contains a
 * literal `..` entry), but the guard costs nothing and a future change to the source content or
 * this module's own file-listing logic is exactly the kind of thing that could introduce one
 * silently otherwise.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(root, relativePath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing to install "${relativePath}": it resolves outside ${resolvedRoot}.`);
  }
  return resolvedTarget;
}

/**
 * The guard `resolveWithinRoot` alone can't provide: a lexical, string-only check never touches
 * the filesystem, so it can't see a symlink swapped in for a real directory. Reviewer's finding:
 * pre-creating `<installedPath>/reference` as a symlink to somewhere else lets every file this
 * function is about to write into `reference/` land at the symlink's real target instead --
 * `mkdirSync(..., { recursive: true })` on a path that passes through an existing symlink follows
 * it transparently, so the lexical check (computed before any of that happens) sees only the
 * innocent-looking pre-symlink path.
 *
 * Call this with a destination's *parent* directory after `mkdirSync`'ing it (so it's guaranteed to
 * exist -- `realpathSync` throws on a path that doesn't) and before ever writing the file itself.
 * Resolves both `parentDir` and `root` through any symlink via `realpathSync` and refuses when the
 * former doesn't actually land inside the latter -- the one check that can see through the
 * symlink, since it asks the real filesystem instead of just the path string.
 */
export function assertRealPathWithinRoot(root: string, parentDir: string): void {
  const realRoot = realpathSync(root);
  const realParent = realpathSync(parentDir);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error(
      `Refusing to write into "${parentDir}": it resolves (through a symlink) outside ${realRoot}.`,
    );
  }
}

/**
 * Thrown when a path inside the installed skill directory turns out to be a symlink resolving
 * outside it -- either the destination itself (a tracked file swapped for a symlink to somewhere
 * else, dangling or not: `writeSkillFile`'s and `updateSkill`'s own hash-read loops both check via
 * `assertNotSymlink`) or a parent directory along the way (an old manifest's own key validation:
 * `assertRealPathWithinRoot`, in `skill/update.ts`). Deliberately a different error from
 * `CorruptManifestError`: nothing about a manifest's own text, or a file's own name, is wrong here
 * -- the problem is the filesystem underneath it, not anything a manifest or a relative path says.
 * Reviewer's finding: the first version of this check folded the parent-directory case into
 * `CorruptManifestError`'s own "names a path outside the install directory" wording, which sent a
 * user investigating their manifest's contents instead of the actual symlink sitting in their
 * install directory.
 */
export class SymlinkEscapeError extends Error {
  constructor(escapingPaths: readonly string[], installedPath: string) {
    super(
      `${escapingPaths.join(", ")} resolve${escapingPaths.length === 1 ? "s" : ""} outside ` +
        `${installedPath} through a symlink. Remove or replace ${escapingPaths.length === 1 ? "it" : "them"}, ` +
        "then try again.",
    );
    this.name = "SymlinkEscapeError";
  }
}

/**
 * Refuses (throws `SymlinkEscapeError`) when `destPath` is itself a symlink, whether or not its
 * target exists. Reviewer's finding: `assertRealPathWithinRoot` only guards a destination's
 * *parent* directory -- a tracked file itself swapped for a symlink (`SKILL.md` replaced with a
 * symlink to some file outside the install directory) sails straight through it, and
 * `writeFileSync`/`readFileSync` then follow the link transparently, writing to (or reading from)
 * whatever it points at. `existsSync` can't stand in for this check: it follows the link too, and
 * reports `false` for a dangling one specifically -- exactly the case that must still be caught,
 * since a dangling symlink is not "nothing there yet," it's something there that must not be
 * written through. `lstatSync` never follows the final path component, so it sees the link itself
 * regardless of whether its target exists. Never unlinks or otherwise touches what it finds --
 * refusing is the only outcome, even under `--force` (see `updateSkill`), since `--force` overwrites
 * content this tool itself tracks, not a symlink pointing somewhere else entirely.
 */
export function assertNotSymlink(destPath: string, installedPath: string): void {
  let isSymlink = false;
  try {
    isSymlink = lstatSync(destPath).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (isSymlink) {
    throw new SymlinkEscapeError([destPath], installedPath);
  }
}

/** Exported so `skill/update.ts` can hash a locally-installed file's current content the exact
 * same way, to compare against what an old manifest recorded. */
export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Writes `content` to `destPath`, guarded by `assertNotSymlink` and via a temp file in the same
 * directory (`destParent`) plus an atomic rename over the destination -- `rename(2)` replaces
 * whatever directory entry is there (a stale regular file from a previous install or update, most
 * often) without ever following it, so even a symlink slipped in between the `assertNotSymlink`
 * check and this write can't turn the write into one landing outside the install directory. The
 * temp file's name is randomized (`randomUUID`) so concurrent or interrupted writes to the same
 * destination can never collide with each other, and it lives in `destParent` specifically --
 * never a system temp directory -- so the rename is always same-filesystem and therefore atomic; a
 * leftover temp file from a process that crashed between the write and the rename is harmless to a
 * later run, since that run generates its own fresh, differently-named one.
 *
 * Reviewer's finding (F3): the install manifest itself is just as reachable through this exact
 * attack as any content file -- swapped for a symlink, a plain `writeFileSync` at its path would
 * follow the link and overwrite whatever it points at -- so both `installSkill` and `updateSkill`
 * write the manifest through this same guarded path, not a bare `writeFileSync` of their own.
 */
export function writeGuardedFile(destPath: string, installedPath: string, content: string | Buffer): void {
  assertNotSymlink(destPath, installedPath);
  const destParent = dirname(destPath);
  const tempPath = join(destParent, `.${basename(destPath)}.${randomUUID()}.tmp`);
  writeFileSync(tempPath, content);
  renameSync(tempPath, destPath);
}

/**
 * Writes one skill content file from `sourceDir` into `installedPath`, guarded by
 * `resolveWithinRoot` (lexical) and `assertRealPathWithinRoot` (a symlinked *parent* directory)
 * before anything touches disk, then `writeGuardedFile` for the write itself (the destination file
 * *itself* a symlink, and the actual temp-file-plus-rename write). Returns its sha256 hash for the
 * manifest. The one place both `installSkill`'s and `updateSkill`'s own write loops go through -- a
 * single shared function, not two textually similar copies of the same few lines that could quietly
 * drift out of sync with each other, carrying (or losing) the guard independently.
 */
export function writeSkillFile(sourceDir: string, installedPath: string, relPath: string): string {
  const destPath = resolveWithinRoot(installedPath, relPath);
  const destParent = dirname(destPath);
  mkdirSync(destParent, { recursive: true });
  assertRealPathWithinRoot(installedPath, destParent);
  const content = readFileSync(join(sourceDir, relPath));
  writeGuardedFile(destPath, installedPath, content);
  return sha256Hex(content);
}

/** Every regular file under `dir`, as paths relative to `dir` -- always `/`-separated (POSIX
 * style) regardless of platform, so the manifest this feeds is portable and stable across OSes,
 * and recursive, so a nested directory (`reference/`) is never silently skipped by a shallow
 * listing. Exported so `skill/update.ts` lists the *new* source version's files the same way. */
export function listFilesRecursive(dir: string, prefix = ""): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(join(dir, entry.name), relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

/**
 * Copies the skill's own content (SKILL.md plus the reference directory, recursively) into a
 * target skills directory, and writes an install manifest recording the installed version and a
 * per-file hash next to it. Creates every directory needed, including the target itself, if it
 * doesn't already exist.
 */
export function installSkill(deps: InstallSkillDeps = {}): InstallSkillResult {
  const sourceDir = deps.sourceDir ?? DEFAULT_SKILL_SOURCE_DIR;
  const targetsDir = deps.targetsDir ?? resolveDefaultSkillsDir(deps);
  const installedPath = join(targetsDir, SKILL_NAME);
  const version = deps.packageVersion ?? readPackageVersion();

  const relativeFiles = listFilesRecursive(sourceDir).sort();

  if (conflictsWithExistingInstall(installedPath, relativeFiles)) {
    throw new SkillAlreadyInstalledError(installedPath);
  }

  mkdirSync(installedPath, { recursive: true });
  const files: Record<string, string> = {};

  for (const relPath of relativeFiles) {
    files[relPath] = writeSkillFile(sourceDir, installedPath, relPath);
  }

  const manifest: InstallSkillManifest = { version, files };
  writeGuardedFile(
    join(installedPath, MANIFEST_FILE_NAME),
    installedPath,
    JSON.stringify(manifest, null, 2),
  );

  return { installedPath, fileCount: relativeFiles.length };
}
