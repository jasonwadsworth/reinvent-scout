import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

describe("the lint config's no-console rule", () => {
  const eslint = new ESLint();
  const level = async (path: string) => {
    const config = (await eslint.calculateConfigForFile(path)) as { rules?: Record<string, unknown> };
    const setting = config.rules?.["no-console"];
    return Array.isArray(setting) ? setting[0] : setting;
  };

  it.each(["src/script/main.ts", "src/commands/registry.ts", "src/catalog/import.ts", "src/deeply/nested/new.ts"])("is an error in %s, since stdout carries exactly one JSON document", async (path) => {
    expect(await level(path)).toBe(2);
  });

  it("is off in tests", async () => {
    expect(await level("tests/x.test.ts")).toBe(0);
  });
});
