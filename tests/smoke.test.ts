import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/main.js";
import { readPackageVersion } from "../src/cli/version.js";

describe("cli", () => {
  it("exposes the package version from --version", async () => {
    const expectedVersion = readPackageVersion();

    const program = buildProgram();
    let out = "";
    program.configureOutput({
      writeOut: (str) => {
        out += str;
      },
    });

    // Commander implements `--version` by printing and throwing a CommanderError with
    // exitCode 0, rather than returning normally -- assert that specific shape (not just
    // "it threw something") so a regression that throws a different, real failure would
    // not be masked by a bare `.rejects.toThrow()`.
    let caught: unknown;
    try {
      await program.parseAsync(["node", "reinvent-scout", "--version"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CommanderError);
    expect((caught as CommanderError).code).toBe("commander.version");
    expect((caught as CommanderError).exitCode).toBe(0);
    expect(out.trim()).toBe(expectedVersion);
  });
});
