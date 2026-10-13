import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(root, "plugin", "skills", "reinvent-scout", "scripts", "reinvent-scout.mjs");

export function buildOptions() {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    absWorkingDir: root,
    entryPoints: ["src/script/main.ts"],
    outfile: OUTPUT,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.13",
    legalComments: "none",
    define: { __VERSION__: JSON.stringify(version) },
    logLevel: "warning",
  };
}
