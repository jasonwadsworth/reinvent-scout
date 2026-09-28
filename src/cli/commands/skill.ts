import type { Command } from "commander";
import {
  SkillAlreadyInstalledError,
  installSkill,
  type InstallSkillDeps,
  type InstallSkillResult,
} from "../../skill/install.js";
import { updateSkill, type UpdateSkillDeps, type UpdateSkillResult } from "../../skill/update.js";

export interface SkillCommandDeps {
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
  /** Defaults to `skill/install.ts`'s real `installSkill`. Inject a fake in tests so nothing here
   * touches the real filesystem outside a test's own temp directories. */
  install?: (deps: InstallSkillDeps) => InstallSkillResult;
  /** Defaults to `skill/update.ts`'s real `updateSkill`. Inject a fake in tests so nothing here
   * touches the real filesystem outside a test's own temp directories. */
  update?: (deps: UpdateSkillDeps) => UpdateSkillResult;
}

interface InstallCommandOptions {
  dir?: string;
}

interface UpdateCommandOptions {
  dir?: string;
  force?: boolean;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/** Registers `skill` and its `install` and `update` subcommands. */
export function registerSkillCommands(program: Command, deps: SkillCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const install = deps.install ?? installSkill;
  const update = deps.update ?? updateSkill;

  const skill = program
    .command("skill")
    .description("Install or update the reinvent-scout agent skill for an AI coding agent.");

  skill
    .command("install")
    .description(
      "Install the skill into Claude Code's default skills directory (~/.claude/skills), or " +
        "--dir for another agent (e.g. Kiro).",
    )
    .option("--dir <path>", "install into this skills directory instead of the Claude Code default")
    .action((options: InstallCommandOptions) => {
      try {
        const result = install({ ...(options.dir === undefined ? {} : { targetsDir: options.dir }) });
        print(`Installed ${result.fileCount} ${pluralize(result.fileCount, "file")} to ${result.installedPath}`);
      } catch (err) {
        if (err instanceof SkillAlreadyInstalledError) {
          print(err.message);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  skill
    .command("update")
    .description(
      "Update an already-installed skill without clobbering a locally modified file -- installs " +
        "fresh if nothing is installed yet. --force overwrites local edits instead of refusing.",
    )
    .option("--dir <path>", "the skills directory the skill was installed into (matches install's own --dir)")
    .option("--force", "overwrite locally modified files instead of refusing")
    .action((options: UpdateCommandOptions) => {
      const result = update({
        ...(options.dir === undefined ? {} : { targetsDir: options.dir }),
        ...(options.force === undefined ? {} : { force: options.force }),
      });

      switch (result.status) {
        case "up-to-date":
          print(`Already up to date at ${result.installedPath}`);
          break;
        case "fresh-install":
          print(
            `Installed ${result.fileCount} ${pluralize(result.fileCount, "file")} to ${result.installedPath}`,
          );
          break;
        case "updated": {
          print(
            `Updated ${result.updatedFiles.length} ${pluralize(result.updatedFiles.length, "file")} at ${result.installedPath}`,
          );
          if (result.removedFiles.length > 0) {
            print(`Removed (no longer part of the skill): ${result.removedFiles.join(", ")}`);
          }
          break;
        }
        case "refused": {
          const noun = pluralize(result.modifiedFiles.length, "file");
          const verb = result.modifiedFiles.length === 1 ? "has" : "have";
          print(
            `Refused to update ${result.installedPath}: the following ${noun} ${verb} been modified ` +
              "locally and would be lost:",
          );
          print(result.modifiedFiles.map((f) => `  ${f}`).join("\n"));
          print("Re-run with --force to overwrite the local changes, or edit elsewhere and retry.");
          process.exitCode = 1;
          break;
        }
      }
    });

  return skill;
}
