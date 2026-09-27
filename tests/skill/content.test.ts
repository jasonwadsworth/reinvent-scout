import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildProgram } from "../../src/cli/main.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(here, "..", "..", "skills", "reinvent-scout");
const referenceDir = join(skillRoot, "reference");

function readSkillFile(...parts: string[]): string {
  return readFileSync(join(skillRoot, ...parts), "utf8");
}

const skillMd = readSkillFile("SKILL.md");
const taxonomyMd = readSkillFile("reference", "taxonomy.md");
const workflowMd = readSkillFile("reference", "workflow.md");
const profilingMd = readSkillFile("reference", "profiling.md");

const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

/**
 * Extracts the body of one `## Heading` section (up to, but not including, the next `## ` heading
 * or end of file). Used so extraction never accidentally picks up a backtick-quoted term from
 * unrelated prose elsewhere in the document -- only the one dedicated, exhaustive list section for
 * each category is ever parsed.
 */
function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) {
    throw new Error(`Heading ${JSON.stringify(heading)} not found`);
  }
  const rest = lines.slice(startIndex + 1);
  const endIndex = rest.findIndex((line) => /^##\s/.test(line));
  return (endIndex === -1 ? rest : rest.slice(0, endIndex)).join("\n");
}

/** Bullet items of the form `- \`content\`` -- one per line, backtick-quoted. */
function backtickBullets(section: string): string[] {
  return [...section.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]!);
}

/** Bullet items of the form `- content` -- one per line, plain text. */
function plainBullets(section: string): string[] {
  return [...section.matchAll(/^- (.+)$/gm)].map((match) => match[1]!.trim());
}

/**
 * Walks a commander program's command tree and returns every full invocation path for a leaf
 * command ("auth login", "catalog sync", "match") -- not just top-level group names, which are
 * never invocable on their own. Commander's auto-added "help" pseudo-command is excluded at every
 * level. Mirrors tests/docs.test.ts's own helper -- the same authoritative source the README's own
 * command-coverage test already trusts.
 */
function collectLeafCommandPaths(command: Command, prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const sub of command.commands) {
    if (sub.name() === "help") {
      continue;
    }
    const path = [...prefix, sub.name()];
    if (sub.commands.length === 0) {
      paths.push(path.join(" "));
    } else {
      paths.push(...collectLeafCommandPaths(sub, path));
    }
  }
  return paths;
}

function uniqueFixtureValues(field: "topics" | "roles"): string[] {
  const values = new Set<string>();
  for (const session of fixture) {
    for (const value of session[field] ?? []) {
      values.add(value);
    }
  }
  return [...values];
}

describe("SKILL.md frontmatter", () => {
  it("has valid frontmatter with a name and a description", () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skillMd);
    expect(match).not.toBeNull();
    const frontmatter = match![1]!;
    expect(frontmatter).toMatch(/^name:\s*\S+/m);
    expect(frontmatter).toMatch(/^description:\s*\S+/m);
  });
});

describe("SKILL.md length", () => {
  it("keeps SKILL.md under five hundred lines", () => {
    expect(skillMd.split("\n").length).toBeLessThan(500);
  });
});

describe("SKILL.md tool names", () => {
  it("names only tools the mcp server actually registers, and names every one of them", async () => {
    const home: TempHome = createTempHome();
    try {
      const server = createMcpServer({ resolveStoreRoot: () => home.path });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const registered = new Set(tools.map((tool) => tool.name));

      // A sanity check on the test itself: if the server ever registered nothing, both directions
      // below would pass vacuously.
      expect(registered.size).toBeGreaterThan(0);

      const named = new Set(backtickBullets(extractSection(skillMd, "## MCP tools used")));
      expect(named.size).toBeGreaterThan(0);

      for (const name of named) {
        expect(registered.has(name)).toBe(true);
      }
      for (const name of registered) {
        expect(named.has(name)).toBe(true);
      }
    } finally {
      home.cleanup();
    }
  });
});

describe("SKILL.md and reference/workflow.md CLI command names", () => {
  it("names only commands the cli actually registers, and names every one of them", () => {
    const program = buildProgram();
    const leafPaths = collectLeafCommandPaths(program);

    // A sanity check on the test itself: if buildProgram ever registered nothing, both directions
    // below would pass vacuously.
    expect(leafPaths.length).toBeGreaterThan(0);

    const registered = new Set(leafPaths.map((path) => `reinvent-scout ${path}`));
    const named = new Set(
      backtickBullets(extractSection(workflowMd, "## CLI command reference")),
    );
    expect(named.size).toBeGreaterThan(0);

    for (const name of named) {
      expect(registered.has(name)).toBe(true);
    }
    for (const name of registered) {
      expect(named.has(name)).toBe(true);
    }
  });
});

describe("SKILL.md reference file coverage", () => {
  it("references every file in the reference directory", () => {
    const files = readdirSync(referenceDir);

    // A sanity check on the test itself: if the reference directory were ever emptied out, this
    // would pass vacuously with nothing left to check.
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(skillMd).toContain(`reference/${file}`);
    }
  });
});

describe("reference/taxonomy.md vocabulary", () => {
  it("lists exactly the topics the fixture catalog actually uses", () => {
    const fixtureTopics = new Set(uniqueFixtureValues("topics"));
    expect(fixtureTopics.size).toBeGreaterThan(0);

    const listedTopics = new Set(plainBullets(extractSection(taxonomyMd, "## Topics")));
    expect(listedTopics.size).toBeGreaterThan(0);

    for (const topic of listedTopics) {
      expect(fixtureTopics.has(topic)).toBe(true);
    }
    for (const topic of fixtureTopics) {
      expect(listedTopics.has(topic)).toBe(true);
    }
  });

  it("lists exactly the roles the fixture catalog actually uses", () => {
    const fixtureRoles = new Set(uniqueFixtureValues("roles"));
    expect(fixtureRoles.size).toBeGreaterThan(0);

    const listedRoles = new Set(plainBullets(extractSection(taxonomyMd, "## Roles")));
    expect(listedRoles.size).toBeGreaterThan(0);

    for (const role of listedRoles) {
      expect(fixtureRoles.has(role)).toBe(true);
    }
    for (const role of fixtureRoles) {
      expect(listedRoles.has(role)).toBe(true);
    }
  });
});

describe("SKILL.md auth login instructions", () => {
  it("tells the agent how to run auth login itself rather than deferring to the user", () => {
    expect(skillMd).toMatch(/run\s+`reinvent-scout auth login`\s+yourself/);
  });
});

describe("reference file existence", () => {
  it("ships all three reference files named by the plan", () => {
    expect(taxonomyMd.length).toBeGreaterThan(0);
    expect(workflowMd.length).toBeGreaterThan(0);
    expect(profilingMd.length).toBeGreaterThan(0);
  });
});
