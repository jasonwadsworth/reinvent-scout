import type { Command } from "commander";
import { installSkill, type InstallSkillDeps, type InstallSkillResult } from "../../skill/install.js";

export interface SkillCommandDeps {
  /** Where command output goes. Defaults to stdout. */
  print?: (message: string) => void;
  /** Defaults to `skill/install.ts`'s real `installSkill`. Inject a fake in tests so nothing here
   * touches the real filesystem outside a test's own temp directories. */
  install?: (deps: InstallSkillDeps) => InstallSkillResult;
}

interface InstallCommandOptions {
  dir?: string;
}

/** Registers `skill` and its `install` subcommand (`update` follows in a later task). */
export function registerSkillCommands(program: Command, deps: SkillCommandDeps = {}): Command {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const install = deps.install ?? installSkill;

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
      const result = install({ ...(options.dir === undefined ? {} : { targetsDir: options.dir }) });
      const plural = result.fileCount === 1 ? "" : "s";
      print(`Installed ${result.fileCount} file${plural} to ${result.installedPath}`);
    });

  return skill;
}
