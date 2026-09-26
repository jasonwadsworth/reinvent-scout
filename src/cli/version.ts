import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, "..", "..", "package.json");

/** Reads the `version` field from the package's own package.json. */
export function readPackageVersion(): string {
  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
}
