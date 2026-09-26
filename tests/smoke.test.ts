import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../src/cli/main.js";

describe("cli", () => {
  it("exposes the package version from --version", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };

    const program = buildProgram();
    let out = "";
    program.configureOutput({
      writeOut: (str) => {
        out += str;
      },
    });

    await expect(
      program.parseAsync(["node", "reinvent-scout", "--version"]),
    ).rejects.toThrow();
    expect(out.trim()).toBe(pkg.version);
  });
});
