#!/usr/bin/env node
import { Command } from "commander";
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

  return program;
}

/** Entry point used by the compiled bin script. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err && typeof err === "object" && "exitCode" in err) {
      process.exitCode = (err as { exitCode?: number }).exitCode ?? 1;
      return;
    }
    throw err;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
