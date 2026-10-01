import { existsSync, readFileSync } from "node:fs";
import { catalogServiceNames } from "../catalog/query.js";
import { buildServiceAliasIndex } from "../catalog/service-aliases.js";
import { ValidationError } from "../core/errors.js";
import { resolveProfile, type ResolvedProfile } from "../profile/profile.js";
import { readProfileFile } from "../profile/store.js";

function readRawProfile(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new ValidationError("The profile file is not valid JSON.");
  }
}

/**
 * Loads a profile from `--profile <file|name>`: an existing filesystem path is read directly, and anything else is looked up as a
 * name previously saved with `profile save`. The name form goes through `readProfileFile` -- the exact same
 * `profilePath`/`SAFE_PROFILE_NAME_PATTERN` guard `profile save` enforces -- rather than a second, hand-rolled safety check here.
 * Since a saved name can never contain a path separator, this can't be tricked into resolving a traversal attempt as a name.
 * Resolved against the synced catalog's service names.
 */
export function loadResolvedProfile(profileArg: string, storeRoot: string): ResolvedProfile {
  const content = existsSync(profileArg) ? readFileSync(profileArg, "utf8") : readProfileFile(profileArg, { storeRoot });
  const serviceAliasIndex = buildServiceAliasIndex(catalogServiceNames({ storeRoot }));
  return resolveProfile(readRawProfile(content), serviceAliasIndex);
}
