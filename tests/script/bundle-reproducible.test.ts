import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the bundle is reproducible", () => {
  it("is byte-identical when node_modules is reached through a symlink, and embeds no machine path", async () => {
    const options = (await import(pathToFileURL(join(root, "scripts", "bundle-options.mjs")).href)) as { buildOptions: (root?: string) => Record<string, unknown>; OUTPUT: string };
    const copy = mkdtempSync(join(tmpdir(), "reinvent-bundle-"));
    try {
      cpSync(join(root, "src"), join(copy, "src"), { recursive: true });
      cpSync(join(root, "package.json"), join(copy, "package.json"));
      symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
      const result = await build({ ...options.buildOptions(copy), write: false });
      const text = Buffer.from(result.outputFiles![0]!.contents);
      expect(text.equals(readFileSync(options.OUTPUT))).toBe(true);
      expect(text.toString("utf8")).not.toContain(root);
      expect(text.toString("utf8")).not.toContain(copy);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
