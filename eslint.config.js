// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "plugin/**/scripts/*.mjs"],
  },
  ...tseslint.configs.recommended,
  {
    // stdout carries exactly one JSON document, so nothing in src may print.
    files: ["**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The build scripts are plain Node.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", Buffer: "readonly" } },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
