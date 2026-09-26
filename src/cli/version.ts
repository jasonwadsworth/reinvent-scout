import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultPackageJsonPath = join(here, "..", "..", "package.json");

export interface ReadPackageVersionOptions {
  /** Defaults to this package's own package.json. Inject a path in tests. */
  packageJsonPath?: string;
}

/**
 * Reads the `version` field from a package.json. The parsed JSON is not assumed to have the
 * shape we want -- a malformed or hand-edited manifest is validated and rejected with a clear
 * message rather than handed to callers as an `undefined` or non-string "version".
 */
export function readPackageVersion(options: ReadPackageVersionOptions = {}): string {
  const path = options.packageJsonPath ?? defaultPackageJsonPath;
  const raw = readFileSync(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse ${path} as JSON: ${reason}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} does not contain a JSON object.`);
  }

  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${path} is missing a non-empty string "version" field.`);
  }

  return version;
}
