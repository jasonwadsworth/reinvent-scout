import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

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
 * Resolves the store root and makes sure it exists, mode `0700`. A directory that already
 * exists is left exactly as it is: its mode is never widened (or narrowed).
 */
export function ensureStoreRoot(deps: PathsDeps = {}): string {
  const root = resolveStoreRoot(deps);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
    chmodSync(root, STORE_DIR_MODE);
  }
  return root;
}
