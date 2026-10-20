import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Modules that import only types are erased by esbuild, so they never appear in the bundle's graph.
const TYPE_ONLY = ["src/api/types.ts"];
// Each deletion task shrinks this list; it ends empty.
const KNOWN_DEAD: string[] = [
  "src/api/client.ts",
  "src/auth/browser.ts",
  "src/auth/callback-server.ts",
  "src/auth/login.ts",
  "src/auth/pkce.ts",
  "src/auth/provider-adapter.ts",
  "src/auth/token-provider.ts",
  "src/auth/token-store.ts",
  "src/cli/commands/auth.ts",
  "src/cli/commands/catalog.ts",
  "src/cli/commands/match.ts",
  "src/cli/commands/mcp.ts",
  "src/cli/commands/profile.ts",
  "src/cli/commands/schedule.ts",
  "src/cli/commands/skill.ts",
  "src/cli/entry.ts",
  "src/cli/level-option.ts",
  "src/cli/main.ts",
  "src/cli/profile-input.ts",
  "src/cli/version.ts",
  "src/legacy/api-adapters.ts",
  "src/mcp/response-budget.ts",
  "src/mcp/server.ts",
  "src/mcp/tools.ts",
  "src/profile/store.ts",
  "src/schedule/favorites.ts",
  "src/schedule/schedule.ts",
  "src/skill/install.ts",
  "src/skill/update.ts",
];

describe("plugin only", () => {
  it("every src module is in the bundle's import graph, apart from the known-dead list", async () => {
    const options = (await import(pathToFileURL(join(root, "scripts", "bundle-options.mjs")).href)) as { buildOptions: (root?: string) => Record<string, unknown> };
    const result = await build({ ...options.buildOptions(root), write: false, metafile: true });
    const reachable = Object.keys(result.metafile.inputs).filter((p) => p.startsWith("src/"));
    const all = (readdirSync(join(root, "src"), { recursive: true }) as string[]).filter((p) => p.endsWith(".ts")).map((p) => `src/${p}`);
    expect(all.filter((p) => !reachable.includes(p) && !TYPE_ONLY.includes(p)).sort()).toEqual([...KNOWN_DEAD].sort());
  });
});
