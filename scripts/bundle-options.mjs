import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(defaultRoot, "plugin", "skills", "reinvent-scout", "scripts", "reinvent-scout.mjs");

export function buildOptions(root = defaultRoot) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    absWorkingDir: root,
    entryPoints: ["src/script/main.ts"],
    outfile: join(root, "plugin", "skills", "reinvent-scout", "scripts", "reinvent-scout.mjs"),
    bundle: true,
    // Keep module paths as they are written: a symlinked node_modules (pnpm, CI caches, worktrees) must not put a machine path into the committed bundle.
    preserveSymlinks: true,
    platform: "node",
    format: "esm",
    target: "node22.13",
    legalComments: "none",
    define: { __VERSION__: JSON.stringify(version) },
    logLevel: "warning",
  };
}
