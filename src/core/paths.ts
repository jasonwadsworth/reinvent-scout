import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_DIR_NAME = ".reinvent-scout";

/** The mode every directory under the store root is created at, including the root itself. */
export const STORE_DIR_MODE = 0o700;

export interface PathsDeps {
  /** Defaults to `process.env`. Inject a fixed object so no test reads the real environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `os.homedir`. Inject a stub so no test touches the real home directory. */
  homedir?: () => string;
}

/**
 * Resolves the store root: `REINVENT_SCOUT_HOME` when set, otherwise `~/.reinvent-scout`.
 * Does not touch the filesystem.
 */
export function resolveStoreRoot(deps: PathsDeps = {}): string {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? osHomedir;

  const override = env.REINVENT_SCOUT_HOME;
  if (override && override.length > 0) {
    return override;
  }

  return join(homedir(), STORE_DIR_NAME);
}

/**
 * Creates `path` and every missing parent directory, each at `mode`. `mkdirSync`'s own `mode`
 * option is filtered by the process umask, which would leave a directory narrower than
 * requested under a restrictive umask -- so every directory this creates is `chmod`'d
 * explicitly afterward instead of relying on that option. A directory that already exists
 * (at any level, including `path` itself) is left untouched: its mode is never widened or
 * narrowed by this call.
 *
 * Exported so any module that needs to create a directory under the store root at the store's
 * own mode (currently: the token store, which writes `tokens.json` at a possibly-not-yet-
 * created root) shares this hardening instead of falling back to a bare, umask-dependent
 * `mkdirSync`.
 */
export function ensureDirWithMode(path: string, mode: number): void {
  const parent = dirname(path);
  if (parent !== path) {
    ensureDirWithMode(parent, mode);
  }
  // Create first and treat "already exists" as the answer, rather than checking existence and
  // then creating: two processes (the CLI and the MCP server share one store) can race between
  // those two steps, and the loser would throw EEXIST out of a function whose whole job is to
  // make the directory exist. An existing directory is left exactly as it is, mode included.
  try {
    mkdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    if (!statSync(path).isDirectory()) {
      throw new Error(`Cannot create directory ${path}: a file already exists at that path.`);
    }
    return;
  }
  chmodSync(path, mode);
}

/**
 * Resolves the store root and makes sure it exists, mode `0700` -- including any missing
 * parent directories, which are created at `0700` too rather than left at whatever mode
 * `mkdir -p` would otherwise give them. A directory that already exists is left exactly as it
 * is: its mode is never widened (or narrowed).
 */
export function ensureStoreRoot(deps: PathsDeps = {}): string {
  const root = resolveStoreRoot(deps);
  ensureDirWithMode(root, STORE_DIR_MODE);
  return root;
}
