import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when this module was invoked directly as the process entry point (`node
 * dist/cli/main.js ...` or via the installed `bin` shim), as opposed to being imported by
 * another module (including a test).
 *
 * Comparing `import.meta.url` to a naively-built `file://${process.argv[1]}` string breaks
 * whenever the install path contains characters a file URL must percent-encode -- a space
 * being the common case, since a URL renders it as `%20` while `process.argv[1]` never does.
 * Decoding the URL back into an OS path with `fileURLToPath` and comparing plain paths avoids
 * that entirely. Both sides are also resolved with `realpathSync` so a bin installed via a
 * symlink (as npm's global bin shims and many package managers do) still compares equal.
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }

  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }

  const resolve = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };

  return resolve(modulePath) === resolve(argv1);
}
