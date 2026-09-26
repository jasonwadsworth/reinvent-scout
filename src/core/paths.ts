import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_DIR_NAME = ".reinvent-scout";
const STORE_DIR_MODE = 0o700;

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
 */
function mkdirRecursiveWithMode(path: string, mode: number): void {
  if (existsSync(path)) {
    return;
  }
  const parent = dirname(path);
  if (parent !== path) {
    mkdirRecursiveWithMode(parent, mode);
  }
  mkdirSync(path);
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
  mkdirRecursiveWithMode(root, STORE_DIR_MODE);
  return root;
}
