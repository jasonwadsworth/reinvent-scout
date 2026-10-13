import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const readJson = (...parts: string[]) => JSON.parse(read(...parts)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const pkg = readJson("package.json");

const AWS_READ_TOOLS = ["GetEvent", "ListSessions"];
// The AWS Events MCP names its tools with a stage prefix, so the full names carry it (checked against a live session).
const INFIX = "AWSEventsPublicApi-Mcp-prod___";
const PREFIXES = [`mcp__plugin_reinvent-scout_awsevents__${INFIX}`, `mcp__awsevents__${INFIX}`];

/** The frontmatter block of a markdown file, as raw text. */
function frontmatter(text: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no frontmatter");
  return match[1]!;
}

describe("plugin manifest", () => {
  const plugin = readJson("plugin", ".claude-plugin", "plugin.json");
  it("names the plugin and tracks package.json's version", () => {
    expect(plugin.name).toBe("reinvent-scout");
    expect(plugin.version).toBe(pkg.version);
    expect(typeof plugin.description).toBe("string");
    expect(plugin.author?.name).toBeTruthy();
    expect(plugin.repository).toContain("github.com/jasonwadsworth/reinvent-scout");
    expect(plugin.license).toBeTruthy();
  });
});

describe("marketplace manifest", () => {
  const marketplace = readJson(".claude-plugin", "marketplace.json");
  it("lists exactly the one plugin, sourced from ./plugin", () => {
    expect(marketplace.name).toBe("reinvent-scout");
    expect(marketplace.owner?.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({ name: "reinvent-scout", source: "./plugin" });
  });
});

describe("plugin MCP declaration", () => {
  const mcp = readJson("plugin", ".mcp.json");
  it("declares only the AWS Events server, with the public OAuth client and a fixed callback port", () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(["awsevents"]);
    expect(mcp.mcpServers.awsevents).toEqual({
      type: "http",
      url: "https://api.awsevents.com/mcp",
      oauth: { clientId: "7vmom55m1qstvq8i71ph127bfq", callbackPort: 8484 },
    });
  });
});

describe("catalog-sync agent", () => {
  const text = read("plugin", "agents", "catalog-sync.md");
  const fm = frontmatter(text);
  it("has frontmatter with a name, a description and a tools list", () => {
    expect(fm).toMatch(/^name: catalog-sync$/m);
    expect(fm).toMatch(/^description: .+/m);
    expect(fm).toMatch(/^tools: .+/m);
  });
  it("can run the script and read, and reach GetEvent and ListSessions under both server names", () => {
    const tools = /^tools: (.+)$/m.exec(fm)![1]!.split(",").map(tool => tool.trim());
    expect(tools).toContain("Bash");
    expect(tools).toContain("Read");
    for (const prefix of PREFIXES) for (const tool of AWS_READ_TOOLS) expect(tools).toContain(`${prefix}${tool}`);
  });
  it("runs on a small model with a bounded number of turns", () => {
    expect(fm).toMatch(/^model: haiku$/m);
    expect(fm).toMatch(/^maxTurns: \d+$/m);
  });
});

describe("plugin layout", () => {
  it("ships no CLAUDE.md inside the plugin (the validator warns about it)", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
    expect(walk(join(root, "plugin")).filter(path => path.endsWith("CLAUDE.md"))).toEqual([]);
  });
  it("carries the skill, its references and the bundled script", () => {
    for (const file of ["SKILL.md", "reference/workflow.md", "reference/watch.md", "reference/profiling.md", "reference/taxonomy.md", "scripts/reinvent-scout.mjs"]) {
      expect(existsSync(join(root, "plugin", "skills", "reinvent-scout", file)), file).toBe(true);
    }
    expect(existsSync(join(root, "skills"))).toBe(false);
  });
  it("passes `claude plugin validate --strict` for the plugin and the marketplace when claude is installed", (ctx) => {
    const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) ctx.skip();
    for (const target of ["./plugin", "."]) {
      const result = spawnSync("claude", ["plugin", "validate", target, "--strict"], { cwd: root, encoding: "utf8" });
      expect(result.status, `${target}: ${result.stdout}${result.stderr}`).toBe(0);
    }
  });
});
