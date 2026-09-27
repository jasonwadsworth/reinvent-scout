import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic-write.js";
import { ValidationError } from "../core/errors.js";
import { ensureDirWithMode, STORE_DIR_MODE } from "../core/paths.js";

const PROFILES_DIR_NAME = "profiles";
const PROFILE_FILE_MODE = 0o600;

/**
 * A profile name may only be a single, safe path segment: letters, digits, dots, hyphens and
 * underscores, never starting or ending with a dot (which rules out `"."` and `".."` outright,
 * along with a hidden-file-style leading dot or a trailing one) and, since it contains none of
 * `/` or `\`, never spanning a directory. This matters because the name becomes a filename
 * directly, under `<store>/profiles/<name>.json`, and neither caller that supplies it -- a
 * person via the CLI, or (from part 3) an agent via an MCP tool, the least trusted caller in this
 * system -- is implicitly trusted with the filesystem beyond the store.
 */
const SAFE_PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface ProfileStoreDeps {
  storeRoot: string;
}

function assertSafeProfileName(name: string): void {
  if (!SAFE_PROFILE_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `"${name}" is not a valid profile name. Use only letters, digits, dots, hyphens and ` +
        "underscores, and never start or end with a dot.",
    );
  }
}

function profilesDir(storeRoot: string): string {
  return join(storeRoot, PROFILES_DIR_NAME);
}

/** The path a profile named `name` is stored at. Throws `ValidationError` for a name that isn't
 * a single safe path segment -- rejected outright rather than sanitized, so the caller (and, for
 * an MCP tool, the agent behind it) learns the name was refused rather than silently getting a
 * different file than the one it asked for. */
export function profilePath(name: string, deps: ProfileStoreDeps): string {
  assertSafeProfileName(name);
  return join(profilesDir(deps.storeRoot), `${name}.json`);
}

/** Persists `content` under the given profile name, atomically at mode `0600`, creating the
 * `profiles` directory (and the store root above it) at `0700` if needed -- the same hardened,
 * umask-independent directory creation every other store in this codebase uses. Does not
 * validate `content` as a profile; that's `profile.ts`'s job, done before this is ever called. */
export function saveProfileFile(name: string, content: string, deps: ProfileStoreDeps): void {
  const path = profilePath(name, deps);
  ensureDirWithMode(profilesDir(deps.storeRoot), STORE_DIR_MODE);
  writeFileAtomic(path, () => content, { mode: PROFILE_FILE_MODE });
}

/** Reads back a profile previously saved under `name`. Throws the same `ValidationError` as
 * `saveProfileFile` for an unsafe name, and whatever `node:fs` throws (e.g. `ENOENT`) for a name
 * that's safe but was never saved. */
export function readProfileFile(name: string, deps: ProfileStoreDeps): string {
  const path = profilePath(name, deps);
  return readFileSync(path, "utf8");
}
