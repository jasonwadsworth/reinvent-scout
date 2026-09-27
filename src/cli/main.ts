#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerCatalogCommands } from "./commands/catalog.js";
import { registerMatchCommands } from "./commands/match.js";
import { registerProfileCommands } from "./commands/profile.js";
import { isMainModule } from "./entry.js";
import { readPackageVersion } from "./version.js";

/**
 * Builds the commander program with every subcommand registered.
 *
 * `exitOverride()` is set so callers (including tests) can catch a
 * `CommanderError` instead of the process exiting out from under them.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("reinvent-scout")
    .description(
      "Sign in, sync the re:Invent catalog, profile a repo, and get matched sessions with evidence.",
    )
    .version(readPackageVersion())
    .exitOverride();

  registerAuthCommands(program);
  registerCatalogCommands(program);
  registerProfileCommands(program);
  registerMatchCommands(program);

  return program;
}

/** Entry point used by the compiled bin script. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
      return;
    }
    throw err;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
