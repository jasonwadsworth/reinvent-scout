import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHome {
  /** A fresh, empty directory this test owns exclusively. */
  path: string;
  /** `process.env` plus `REINVENT_SCOUT_HOME` pointing at `path`, safe to pass to any injected `env`. */
  env: NodeJS.ProcessEnv;
  /** Removes the directory tree. Call in `afterEach`. */
  cleanup: () => void;
}

/**
 * Creates a per-test store root under the OS temp directory so no test ever reads or writes a
 * real home directory.
 */
export function createTempHome(): TempHome {
  const path = mkdtempSync(join(tmpdir(), "reinvent-scout-test-"));
  return {
    path,
    env: { ...process.env, REINVENT_SCOUT_HOME: path },
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
