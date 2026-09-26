import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { z } from "zod";
import { catalogServiceNames } from "../../catalog/query.js";
import { buildServiceAliasIndex } from "../../catalog/service-aliases.js";
import {
  CatalogMissingError,
  CatalogUnusableError,
  ValidationError,
} from "../../core/errors.js";
import { ensureStoreRoot } from "../../core/paths.js";
import { parseProfile, resolveProfile, type ResolvedProfile } from "../../profile/profile.js";
import { readProfileFile, saveProfileFile } from "../../profile/store.js";

export interface ProfileCommandDeps {
  /** Defaults to the real store root (`ensureStoreRoot`). Inject a fixed path in tests so
   * nothing touches the real home directory. */
  resolveStoreRoot?: () => string;
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
}

interface ValidateCommandOptions {
  name?: string;
  json: boolean;
}

interface SaveCommandOptions {
  from: string;
}

/** Every issue's own message, one per line -- this is what makes the schema's `superRefine`
 * messages (e.g. `Service "dynamodb" has no evidence`) actually reach the user, rather than a
 * flattened generic "invalid profile" that would throw away the one thing the schema was
 * designed to say. */
function formatZodError(err: z.ZodError): string {
  return err.issues.map((issue) => issue.message).join("\n");
}

function formatHumanSummary(resolved: ResolvedProfile): string {
  const lines = [
    `${resolved.repos.length} repo(s), ${resolved.services.length} service(s), ` +
      `${resolved.patterns.length} pattern(s).`,
  ];
  if (resolved.unresolvedServices.length > 0) {
    lines.push(
      `Warning: ${resolved.unresolvedServices.length} service name(s) did not resolve to a ` +
        `catalog session: ${resolved.unresolvedServices.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

function readRawProfile(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new ValidationError("The profile file is not valid JSON.");
  }
}

/** Registers `profile` and its `validate` and `save` subcommands. */
export function registerProfileCommands(program: Command, deps: ProfileCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const resolveStoreRoot = deps.resolveStoreRoot ?? (() => ensureStoreRoot());

  const profile = program.command("profile").description("Validate and manage agent-authored tech profiles.");

  profile
    .command("validate")
    .description("Validate a profile and resolve its service names against the catalog.")
    .argument("[file]", "path to a profile JSON file to validate")
    .option("--name <name>", "validate a profile previously saved with `profile save`")
    .option("--json", "print machine-readable JSON instead of a human-readable summary")
    .action((file: string | undefined, options: ValidateCommandOptions) => {
      const storeRoot = resolveStoreRoot();

      try {
        if (file !== undefined && options.name !== undefined) {
          throw new ValidationError("Provide either a profile file or --name, not both.");
        }
        if (file === undefined && options.name === undefined) {
          throw new ValidationError(
            "Provide a profile file to validate, or --name <name> for a previously saved one.",
          );
        }

        const content =
          options.name !== undefined
            ? readProfileFile(options.name, { storeRoot })
            : readFileSync(file!, "utf8");

        const rawProfile = readRawProfile(content);
        const serviceNames = catalogServiceNames({ storeRoot });
        const serviceAliasIndex = buildServiceAliasIndex(serviceNames);
        const resolved = resolveProfile(rawProfile, serviceAliasIndex);

        print(options.json ? JSON.stringify(resolved) : formatHumanSummary(resolved));
      } catch (err) {
        if (err instanceof z.ZodError) {
          print(formatZodError(err));
          process.exitCode = 1;
          return;
        }
        if (
          err instanceof CatalogMissingError ||
          err instanceof CatalogUnusableError ||
          err instanceof ValidationError
        ) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  profile
    .command("save")
    .description("Save a profile under the store root by name.")
    .argument("<name>", "name to save the profile under")
    .requiredOption("--from <file>", "path to the profile JSON file to save")
    .action((name: string, options: SaveCommandOptions) => {
      const storeRoot = resolveStoreRoot();

      try {
        const content = readFileSync(options.from, "utf8");
        const rawProfile = readRawProfile(content);
        // Schema validation only, not resolution: save must work before a catalog has ever been
        // synced, and the exact set of resolvable services can change between save and a later
        // `validate --name`, so re-resolving here would tell the caller nothing durable.
        parseProfile(rawProfile);

        saveProfileFile(name, content, { storeRoot });
        print(`Saved profile "${name}".`);
      } catch (err) {
        if (err instanceof z.ZodError) {
          print(formatZodError(err));
          process.exitCode = 1;
          return;
        }
        if (err instanceof ValidationError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return profile;
}
