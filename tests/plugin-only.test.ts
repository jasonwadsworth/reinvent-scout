import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Modules that import only types are erased by esbuild, so they never appear in the bundle's graph.
const TYPE_ONLY = ["src/aws/types.ts"];
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

  it("no source file describes a removed surface", () => {
    const removed = /\bCLI\b|MCP server|MCP tool|catalog_sync|get_schedule|get_session|reserve_sessions|cancel_reservation|favorite_sessions|unfavorite_session|reinvent-scout (?:auth|catalog|profile|match|schedule|skill|mcp)\b|errorMaxChars|signed-in session/;
    for (const file of tsFilesUnder("src")) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(removed);
    }
  });

  it("package.json is a private plugin package", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { private?: boolean; bin?: unknown; files?: unknown; description: string; scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.private).toBe(true);
    expect(pkg.bin).toBeUndefined();
    expect(pkg.files).toBeUndefined();
    expect(pkg.scripts.build).toBeUndefined();
    expect(pkg.scripts.check).toBe("npm run typecheck && npm run lint && npm run test && npm run bundle:verify");
    expect(Object.keys(pkg.dependencies)).toEqual(["zod"]);
    expect(pkg.description).toContain("Claude Code plugin");
    for (const [name, command] of Object.entries(pkg.scripts)) {
      for (const match of command.matchAll(/\bnode\s+(\S+)/g)) expect(existsSync(join(root, match[1]!)), `${name}: ${match[1]}`).toBe(true);
    }
  });

  it("no config or doc names a removed path or command", () => {
    const removed = /src\/(?:cli|mcp|skill|auth|api|legacy)\b|dist\/cli|tests\/(?:cli|mcp|auth|api|integration|legacy)\b|fake-fetch|@modelcontextprotocol|\bcommander\b|skill (?:install|update)|reinvent-scout mcp|npm run build/;
    const files = [
      "package.json", "eslint.config.js", "tsconfig.json", "tsconfig.tests.json", "vitest.config.ts", "CLAUDE.md",
      ".claude-plugin/marketplace.json", "plugin/.claude-plugin/plugin.json", "plugin/.mcp.json",
      ...filesUnder(".github/workflows").filter(p => p.endsWith(".yml")),
      ...filesUnder("scripts").filter(p => p.endsWith(".mjs")),
      ...filesUnder("plugin/agents").filter(p => p.endsWith(".md")),
      ...filesUnder("plugin/skills").filter(p => p.endsWith(".md")),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(removed);
  });
});

function tsFilesUnder(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[]).filter(p => p.endsWith(".ts")).map(p => `${dir}/${p}`);
}

/** Every `from "..."`, `import "..."` and `import("...")` specifier in a source text. */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/\b(?:from|import)\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1] ?? match[2]!);
}

function filesUnder(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[]).map(p => `${dir}/${p}`);
}
