import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Modules that import only types are erased by esbuild, so they never appear in the bundle's graph.
const TYPE_ONLY = ["src/api/types.ts"];
// Empty: add nothing here; delete the module instead.
const KNOWN_DEAD: string[] = [];

describe("plugin only", () => {
  it("every src module is in the bundle's import graph, apart from the known-dead list", async () => {
    const options = (await import(pathToFileURL(join(root, "scripts", "bundle-options.mjs")).href)) as { buildOptions: (root?: string) => Record<string, unknown> };
    const result = await build({ ...options.buildOptions(root), write: false, metafile: true });
    const reachable = Object.keys(result.metafile.inputs).filter((p) => p.startsWith("src/"));
    const all = (readdirSync(join(root, "src"), { recursive: true }) as string[]).filter((p) => p.endsWith(".ts")).map((p) => `src/${p}`);
    expect(all.filter((p) => !reachable.includes(p) && !TYPE_ONLY.includes(p)).sort()).toEqual([...KNOWN_DEAD].sort());
  });

  it("no source or test file imports the MCP SDK, commander, or a removed directory", () => {
    const REMOVED_DIRS = ["src/cli/", "src/mcp/", "src/skill/", "src/legacy/", "src/auth/"];
    const REMOVED_FILES = ["src/profile/store.ts", "src/api/client.ts", "src/catalog/sync.ts", "src/schedule/favorites.ts", "src/schedule/reservations.ts", "src/schedule/schedule.ts", "src/schedule/write-quota.ts"];
    const offenders: string[] = tsFilesUnder("src").filter(file => REMOVED_DIRS.some(dir => file.startsWith(dir)) || REMOVED_FILES.includes(file)).map(file => `${file}: still exists`);
    for (const file of tsFilesUnder("src").concat(tsFilesUnder("tests"))) {
      const text = readFileSync(join(root, file), "utf8");
      for (const specifier of importSpecifiers(text)) {
        if (/^(?:@modelcontextprotocol\/sdk|commander)(?:\/|$)/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
          continue;
        }
        if (!specifier.startsWith(".")) continue;
        const target = relative(root, resolve(join(root, dirname(file)), specifier)).replace(/\.js$/, ".ts");
        if (REMOVED_DIRS.some(dir => target.startsWith(dir)) || REMOVED_FILES.includes(target)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function tsFilesUnder(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[]).filter(p => p.endsWith(".ts")).map(p => `${dir}/${p}`);
}

/** Every `from "..."`, `import "..."` and `import("...")` specifier in a source text. */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/\b(?:from|import)\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1] ?? match[2]!);
}
