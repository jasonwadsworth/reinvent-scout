// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["src/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // The MCP server's CLI entry point shares stdout with the JSON-RPC protocol stream, so it
    // cannot inherit src/cli/**'s general no-console exemption above: `console.*` bypasses even a
    // direct process.stdout.write capture (Node's Console holds its own stream reference), so a
    // stray console.log here would corrupt the stream in a way no in-process test could catch.
    // Listed after the src/cli/**/*.ts override above so it wins (flat config: last match wins).
    files: ["src/cli/commands/mcp.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
