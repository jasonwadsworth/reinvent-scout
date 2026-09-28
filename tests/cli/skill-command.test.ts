import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSkillCommands } from "../../src/cli/commands/skill.js";
import type { InstallSkillDeps, InstallSkillResult } from "../../src/skill/install.js";

interface Harness {
  run: (args: string[]) => Promise<void>;
  printed: string[];
  installCalls: InstallSkillDeps[];
}

function harness(installResult: InstallSkillResult): Harness {
  const printed: string[] = [];
  const installCalls: InstallSkillDeps[] = [];
  const program = new Command().exitOverride();
  registerSkillCommands(program, {
    print: (message: string) => {
      printed.push(message);
    },
    install: (deps: InstallSkillDeps) => {
      installCalls.push(deps);
      return installResult;
    },
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
    installCalls,
  };
}

describe("skill install command", () => {
  it("installs to the default location and reports the path and file count", async () => {
    const h = harness({ installedPath: "/home/user/.claude/skills/reinvent-scout", fileCount: 4 });

    await h.run(["skill", "install"]);

    expect(h.installCalls).toHaveLength(1);
    expect(h.installCalls[0]!.targetsDir).toBeUndefined();
    expect(h.printed).toHaveLength(1);
    expect(h.printed[0]).toContain("/home/user/.claude/skills/reinvent-scout");
    expect(h.printed[0]).toContain("4");
  });

  it("installs into an explicit --dir when given", async () => {
    const h = harness({ installedPath: "/opt/kiro/skills/reinvent-scout", fileCount: 4 });

    await h.run(["skill", "install", "--dir", "/opt/kiro/skills"]);

    expect(h.installCalls).toHaveLength(1);
    expect(h.installCalls[0]!.targetsDir).toBe("/opt/kiro/skills");
  });

  it("uses singular file wording for exactly one file", async () => {
    const h = harness({ installedPath: "/home/user/.claude/skills/reinvent-scout", fileCount: 1 });

    await h.run(["skill", "install"]);

    expect(h.printed[0]).toMatch(/1 file to /);
    expect(h.printed[0]).not.toMatch(/1 files to /);
  });
});
