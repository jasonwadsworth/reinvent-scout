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
import { buildValidateReport } from "../../profile/report.js";
import { readProfileFile, saveProfileFile } from "../../profile/store.js";
import { formatZodError } from "../zod-errors.js";
import { loadResolvedProfile } from "../profile-input.js";
import { mapProfile, type MapTopic, type ProfileMap } from "../../match/map.js";

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

function formatHumanSummary(resolved: ResolvedProfile): string {
  const lines = [
    `${resolved.repos.length} repo(s), ${resolved.services.length} service(s), ` +
      `${resolved.patterns.length} pattern(s).`,
    ...resolved.services.map((service) => `  ${service.name} -> ${service.catalogName ?? "unresolved"}`),
    `Patterns: ${resolved.patterns.map((pattern) => pattern.name).join(", ") || "none"}`,
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

const GOAL_PHRASES: Record<string, string> = { understand: "No introductory sessions", deepen: "No sessions that go deeper", improve: "No sessions" };

function formatTopic(topic: MapTopic): string {
  const places = topic.evidence.map(place => `${place.repo}/${place.file}${place.line === undefined ? "" : `:${place.line}`}`);
  const open = topic.goals.filter(goal => goal.sessions > 0).map(goal => `${goal.goal} (${goal.sessions} session${goal.sessions === 1 ? "" : "s"})`);
  return [
    `  ${topic.label}  [${topic.id}]${topic.pillar === undefined ? "" : ` (${topic.pillar})`}`,
    ...(topic.note === undefined ? [] : [`    ${topic.note}`]),
    ...(places.length === 0 ? [] : [`    Your code: ${places.join(", ")}${topic.more === undefined ? "" : ` (+${topic.more} more)`}`]),
    ...(topic.skipped === undefined ? [] : [`    skipped: ${topic.skipped}`]),
    ...(open.length === 0 ? [] : [`    ${open.join(", ")}`]),
  ].join("\n");
}

/** One line per goal that has dead ends in the group, instead of a "0 sessions" on every topic, with the closest 300-level session
 * where the explain lens found one. */
function formatDeadEnds(topics: readonly MapTopic[]): string[] {
  const lines: string[] = [];
  for (const goal of ["understand", "deepen", "improve"] as const) {
    const dead = topics.filter(topic => topic.goals.some(entry => entry.goal === goal && entry.sessions === 0));
    if (dead.length > 0) lines.push(`  ${GOAL_PHRASES[goal]} in the catalog for: ${dead.map(topic => topic.label).join(", ")}`);
    for (const topic of dead) {
      const hint = /the closest is a 300-level one: (.*)$/.exec(topic.goals.find(entry => entry.goal === goal)?.reason ?? "")?.[1];
      if (hint !== undefined) lines.push(`    closest 300-level for ${topic.label}: ${hint}`);
    }
  }
  return lines;
}

function formatMap(map: ProfileMap): string {
  const sections: Array<[string, MapTopic[]]> = [["Services", map.services], ["Patterns", map.patterns], ["Gaps", map.gaps], ["Next steps", map.nextSteps]];
  return sections.filter(([, topics]) => topics.length > 0).map(([name, topics]) => [`${name}:`, ...topics.map(formatTopic), ...formatDeadEnds(topics)].join("\n")).join("\n\n");
}

/** Registers `profile` and its `validate`, `save` and `map` subcommands. */
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

        print(options.json ? JSON.stringify(buildValidateReport(resolved)) : formatHumanSummary(resolved));
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

  profile
    .command("map")
    .description("Show what the profile found in the code, as topics to choose from with `match --focus`.")
    .requiredOption("--profile <file|name>", "a profile file path, or a name saved with `profile save`")
    .option("--json", "print machine-readable JSON instead of a readable list")
    .action((options: { profile: string; json?: boolean }) => {
      const storeRoot = resolveStoreRoot();
      try {
        const map = mapProfile(loadResolvedProfile(options.profile, storeRoot), { storeRoot });
        print(options.json === true ? JSON.stringify(map) : formatMap(map));
      } catch (err) {
        if (err instanceof z.ZodError) {
          print(formatZodError(err));
          process.exitCode = 1;
          return;
        }
        if (err instanceof CatalogMissingError || err instanceof CatalogUnusableError || err instanceof ValidationError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return profile;
}
