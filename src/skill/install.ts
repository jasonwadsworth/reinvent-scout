import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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

/** Exported so `skill/update.ts` can hash a locally-installed file's current content the exact
 * same way, to compare against what an old manifest recorded. */
export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
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

  mkdirSync(installedPath, { recursive: true });

  const relativeFiles = listFilesRecursive(sourceDir).sort();
  const files: Record<string, string> = {};

  for (const relPath of relativeFiles) {
    const destPath = resolveWithinRoot(installedPath, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    const content = readFileSync(join(sourceDir, relPath));
    writeFileSync(destPath, content);
    files[relPath] = sha256Hex(content);
  }

  const manifest: InstallSkillManifest = { version, files };
  writeFileSync(join(installedPath, MANIFEST_FILE_NAME), JSON.stringify(manifest, null, 2));

  return { installedPath, fileCount: relativeFiles.length };
}
