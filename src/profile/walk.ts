import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directory names never descended into, wherever they appear in the tree -- dependency
 * installs, VCS internals, and build/tool caches that are both huge and never authored by the
 * repository itself. Matched against the entry's own name, not a full path, so `foo/vendor` is
 * skipped exactly like `vendor` at the root. */
const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".venv",
  "vendor",
  "target",
  ".terraform",
]);

/** File names never read, regardless of extension. */
const SKIPPED_FILE_NAMES: ReadonlySet<string> = new Set([".env"]);

/** File extensions never read -- private key material, whatever manifest or import statement
 * might otherwise reference it. */
const SKIPPED_FILE_EXTENSIONS: ReadonlySet<string> = new Set([".pem", ".key"]);

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024;

export interface WalkOptions {
  /** How many directory levels below the root may be descended into. A file directly in the
   * root is always visible regardless of this value; `maxDepth: 1` means no subdirectory is ever
   * entered. Defaults to 8. */
  maxDepth?: number;
  /** The walk stops (and `truncated` is reported `true`) once this many files have been
   * accepted, even if more remain. Defaults to 5,000. */
  maxFiles?: number;
  /** A file larger than this is skipped outright -- never opened, never counted against
   * `maxFiles`. Defaults to 512 KB. */
  maxFileSizeBytes?: number;
}

export interface WalkResult {
  /** Every accepted file's path, relative to `root`, in traversal order. */
  files: string[];
  /** `true` when `maxFiles` was reached before the whole tree was visited -- a caller
   * (`profile.ts`) surfaces this as a warning rather than silently returning a partial profile. */
  truncated: boolean;
}

function isWithinRoot(candidateRealPath: string, rootRealPath: string): boolean {
  return candidateRealPath === rootRealPath || candidateRealPath.startsWith(rootRealPath + sep);
}

function isSkippedFileName(name: string): boolean {
  if (SKIPPED_FILE_NAMES.has(name)) {
    return true;
  }
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    // No extension, or a dotfile like ".gitignore" whose "extension" is its whole name -- neither
    // is what SKIPPED_FILE_EXTENSIONS means to match.
    return false;
  }
  return SKIPPED_FILE_EXTENSIONS.has(name.slice(dotIndex));
}

/**
 * Walks a repository from `root`, collecting file paths for the profiler's detectors while never
 * descending into a dependency install, a VCS or build directory, or a symlink that escapes the
 * root, and never reading a credential-shaped file (`.env`, `*.pem`, `*.key`) at all -- these are
 * excluded before any `stat` on their contents, not filtered out afterward.
 *
 * A symlink is resolved and checked against the root's own resolved path before being followed,
 * whether it points at a file or a directory; one that resolves outside the root is skipped
 * entirely, neither read nor descended into. The root itself is resolved once up front so this
 * comparison is correct even when the root path itself passes through a symlink (as `os.tmpdir()`
 * commonly does on macOS, where `/tmp` is itself a symlink to `/private/tmp`).
 */
export function walkRepo(root: string, options: WalkOptions = {}): WalkResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  const rootRealPath = realpathSync(root);
  const files: string[] = [];
  let truncated = false;

  function visit(dirAbsPath: string, depth: number): void {
    if (truncated) {
      return;
    }

    let entryNames: string[];
    try {
      entryNames = readdirSync(dirAbsPath);
    } catch {
      return;
    }
    entryNames.sort();

    for (const entryName of entryNames) {
      if (truncated) {
        return;
      }

      const entryAbsPath = join(dirAbsPath, entryName);

      let entryLstat;
      try {
        entryLstat = lstatSync(entryAbsPath);
      } catch {
        continue;
      }

      let effectiveAbsPath = entryAbsPath;
      let effectiveStat = entryLstat;

      if (entryLstat.isSymbolicLink()) {
        let realPath: string;
        try {
          realPath = realpathSync(entryAbsPath);
        } catch {
          continue; // Broken symlink -- nothing to walk.
        }
        if (!isWithinRoot(realPath, rootRealPath)) {
          continue; // Never follow a symlink out of the repository root.
        }
        try {
          effectiveStat = statSync(realPath);
        } catch {
          continue;
        }
        effectiveAbsPath = realPath;
      }

      if (effectiveStat.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entryName)) {
          continue;
        }
        if (depth < maxDepth) {
          visit(effectiveAbsPath, depth + 1);
        }
        continue;
      }

      if (!effectiveStat.isFile()) {
        continue; // Sockets, FIFOs, device files -- nothing a detector would ever read.
      }

      if (isSkippedFileName(entryName)) {
        continue;
      }

      if (effectiveStat.size > maxFileSizeBytes) {
        continue;
      }

      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      files.push(relative(root, entryAbsPath));
    }
  }

  visit(root, 1);

  return { files, truncated };
}
