import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSkillCommands } from "../../src/cli/commands/skill.js";
import { SkillAlreadyInstalledError, type InstallSkillDeps, type InstallSkillResult } from "../../src/skill/install.js";
import {
  CorruptManifestError,
  SkillDirectoryUntrackedError,
  SkillNotInstalledError,
  SymlinkEscapeError,
  type UpdateSkillDeps,
  type UpdateSkillResult,
} from "../../src/skill/update.js";

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

  it("exits non-zero and names skill update when a skill is already installed at the target", async () => {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerSkillCommands(program, {
      print: (message: string) => {
        printed.push(message);
      },
      install: () => {
        throw new SkillAlreadyInstalledError("/home/user/.claude/skills/reinvent-scout");
      },
    });
    process.exitCode = undefined;

    await program.parseAsync(["node", "reinvent-scout", "skill", "install"]);

    expect(printed.join("\n")).toMatch(/reinvent-scout skill update/);
    expect(process.exitCode).toBe(1);
  });
});

interface UpdateHarness {
  run: (args: string[]) => Promise<void>;
  printed: string[];
  exitCode: () => number | string | null | undefined;
  updateCalls: UpdateSkillDeps[];
}

function updateHarness(updateResult: UpdateSkillResult): UpdateHarness {
  const printed: string[] = [];
  const updateCalls: UpdateSkillDeps[] = [];
  const program = new Command().exitOverride();
  registerSkillCommands(program, {
    print: (message: string) => {
      printed.push(message);
    },
    update: (deps: UpdateSkillDeps) => {
      updateCalls.push(deps);
      return updateResult;
    },
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
    exitCode: () => process.exitCode,
    updateCalls,
  };
}

describe("skill update command", () => {
  it("reports already up to date", async () => {
    const h = updateHarness({ status: "up-to-date", installedPath: "/home/user/.claude/skills/reinvent-scout" });
    process.exitCode = undefined;

    await h.run(["skill", "update"]);

    expect(h.printed[0]).toMatch(/already up to date/i);
    expect(h.exitCode()).toBeUndefined();
  });

  it("reports the updated file count and any removed files", async () => {
    const h = updateHarness({
      status: "updated",
      installedPath: "/home/user/.claude/skills/reinvent-scout",
      updatedFiles: ["SKILL.md", "reference/profiling.md"],
      removedFiles: ["reference/old-file.md"],
    });
    process.exitCode = undefined;

    await h.run(["skill", "update"]);

    expect(h.printed[0]).toContain("2");
    expect(h.printed.join("\n")).toContain("reference/old-file.md");
    expect(h.exitCode()).toBeUndefined();
  });

  it("refuses and exits non-zero, naming every modified file, when a local edit exists", async () => {
    const h = updateHarness({
      status: "refused",
      installedPath: "/home/user/.claude/skills/reinvent-scout",
      modifiedFiles: ["reference/profiling.md", "SKILL.md"],
    });
    process.exitCode = undefined;

    await h.run(["skill", "update"]);

    const output = h.printed.join("\n");
    expect(output).toContain("reference/profiling.md");
    expect(output).toContain("SKILL.md");
    expect(output).toMatch(/--force/);
    expect(h.exitCode()).toBe(1);
  });

  it("passes --force through to updateSkill", async () => {
    const h = updateHarness({ status: "up-to-date", installedPath: "/home/user/.claude/skills/reinvent-scout" });

    await h.run(["skill", "update", "--force"]);

    expect(h.updateCalls).toHaveLength(1);
    expect(h.updateCalls[0]!.force).toBe(true);
  });

  it("passes --dir through to updateSkill", async () => {
    const h = updateHarness({ status: "up-to-date", installedPath: "/opt/kiro/skills/reinvent-scout" });

    await h.run(["skill", "update", "--dir", "/opt/kiro/skills"]);

    expect(h.updateCalls).toHaveLength(1);
    expect(h.updateCalls[0]!.targetsDir).toBe("/opt/kiro/skills");
  });

  it("exits non-zero and names skill install when updateSkill throws SkillNotInstalledError", async () => {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerSkillCommands(program, {
      print: (message: string) => {
        printed.push(message);
      },
      update: () => {
        throw new SkillNotInstalledError("/home/user/.claude/skills/reinvent-scout");
      },
    });
    process.exitCode = undefined;

    await program.parseAsync(["node", "reinvent-scout", "skill", "update"]);

    expect(printed.join("\n")).toMatch(/reinvent-scout skill install/);
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero and names the manifest path when updateSkill throws CorruptManifestError", async () => {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerSkillCommands(program, {
      print: (message: string) => {
        printed.push(message);
      },
      update: () => {
        throw new CorruptManifestError("/home/user/.claude/skills/reinvent-scout/.install-manifest.json", "not valid JSON");
      },
    });
    process.exitCode = undefined;

    await program.parseAsync(["node", "reinvent-scout", "skill", "update"]);

    expect(printed.join("\n")).toContain(".install-manifest.json");
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero and names --force when updateSkill throws SkillDirectoryUntrackedError", async () => {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerSkillCommands(program, {
      print: (message: string) => {
        printed.push(message);
      },
      update: () => {
        throw new SkillDirectoryUntrackedError("/home/user/.claude/skills/reinvent-scout");
      },
    });
    process.exitCode = undefined;

    await program.parseAsync(["node", "reinvent-scout", "skill", "update"]);

    expect(printed.join("\n")).toMatch(/--force/);
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero and names the symlinked path when updateSkill throws SymlinkEscapeError", async () => {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerSkillCommands(program, {
      print: (message: string) => {
        printed.push(message);
      },
      update: () => {
        throw new SymlinkEscapeError(
          ["/home/user/.claude/skills/reinvent-scout/reference"],
          "/home/user/.claude/skills/reinvent-scout",
        );
      },
    });
    process.exitCode = undefined;

    await program.parseAsync(["node", "reinvent-scout", "skill", "update"]);

    expect(printed.join("\n")).toContain("/home/user/.claude/skills/reinvent-scout/reference");
    expect(printed.join("\n")).toMatch(/symlink/i);
    expect(process.exitCode).toBe(1);
  });
});
