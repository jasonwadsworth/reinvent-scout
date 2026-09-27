import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Reads eslint.config.js's own cascading overrides (via ESLint's own config-resolution API, not
 * a text search of the file), so this reflects exactly what `npm run lint` would enforce -- a
 * later override in the array wins over an earlier one for the same file, and this is the actual
 * mechanism a text-matching test could get wrong.
 *
 * Asserts by path, not by counting overrides: a later, unrelated override added to the config for
 * some other reason must not be able to make this pass vacuously just because *an* override
 * exists somewhere. The MCP server's CLI entry point (src/cli/commands/mcp.ts) needs its own
 * explicit check specifically because it sits *under* src/cli/**, which is otherwise exempt from
 * no-console -- so this also proves the entry file's override actually wins over that broader
 * exemption, not merely that some rule object mentions "error" somewhere.
 */
describe("no-console lint coverage for the MCP server path", () => {
  it("forbids console in the MCP server's CLI entry point, overriding src/cli/**'s general exemption", async () => {
    const eslint = new ESLint();
    const config = await eslint.calculateConfigForFile("src/cli/commands/mcp.ts");

    expect(config.rules?.["no-console"]?.[0]).toBe(2);
  });

  it("forbids console throughout src/mcp/**", async () => {
    const eslint = new ESLint();
    for (const file of ["src/mcp/server.ts", "src/mcp/tools.ts", "src/mcp/deeply/nested.ts"]) {
      const config = await eslint.calculateConfigForFile(file);
      expect(config.rules?.["no-console"]?.[0], file).toBe(2);
    }
  });

  it("leaves every other src/cli/** command exempt, so the override is scoped to the one file", async () => {
    const eslint = new ESLint();
    for (const file of ["src/cli/commands/catalog.ts", "src/cli/commands/auth.ts", "src/cli/main.ts"]) {
      const config = await eslint.calculateConfigForFile(file);
      expect(config.rules?.["no-console"]?.[0], file).toBe(0);
    }
  });
});
