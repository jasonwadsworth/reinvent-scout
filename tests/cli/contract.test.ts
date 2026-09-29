import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registerMatchCommands } from "../../src/cli/commands/match.js";
import { registerProfileCommands } from "../../src/cli/commands/profile.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const lensFixture: Session[] = JSON.parse(readFileSync(join(here, "..", "fixtures", "catalog-lens-sample.json"), "utf8"));
const evidence = [{ repo: "repo", file: "stack.ts", line: 3, snippet: "new Queue()", note: "Queue has no redrive policy" }];
const profile = {
  schemaVersion: 1, repos: [{ root: "repo", languages: [] }],
  services: [{ name: "lambda", role: "core", evidence }, { name: "sqs", evidence }, { name: "eventbridge", evidence }, { name: "stepfunctions", evidence }, { name: "sns", evidence }],
  patterns: [{ name: "gap-no-dlq", evidence }, { name: "genai-single-call", evidence }, { name: "agentic", evidence }],
};

describe("CLI and MCP share one contract", () => {
  let home: TempHome;
  let profilePath: string;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: lensFixture, index: lensFixture.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: lensFixture.length, count: lensFixture.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    profilePath = join(home.path, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));
  });
  afterEach(() => home.cleanup());

  async function cli(register: (program: Command, deps: { resolveStoreRoot: () => string; print: (message: string) => void }) => unknown, args: string[]): Promise<string> {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    register(program, { resolveStoreRoot: () => home.path, print: message => { printed.push(message); } });
    await program.parseAsync(["node", "reinvent-scout", ...args]);
    expect(printed).toHaveLength(1);
    return printed[0]!;
  }
  async function mcp(name: string, args: Record<string, unknown>): Promise<unknown> {
    const server = createMcpServer({ resolveStoreRoot: () => home.path });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    await server.close();
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  }

  it.each(["all", "fix", "next-level"])("match --json prints the object match_sessions returns for the %s lens", async lens => {
    const fromCli = JSON.parse(await cli(registerMatchCommands, ["match", "--profile", profilePath, "--lens", lens, "--limit", "5", "--json"]));
    const fromMcp = await mcp("match_sessions", { profile, lens, limit: 5 });
    expect(fromCli).toEqual(fromMcp);
    expect(Object.keys(fromCli).sort()).toEqual(["candidates", "omitted", "requested", "returned", "skippedRules", "truncated"]);
  });
  it("reports skipped paths and per-candidate lens rules in both", async () => {
    const fromCli = JSON.parse(await cli(registerMatchCommands, ["match", "--profile", profilePath, "--lens", "next-level", "--json"]));
    expect(fromCli.skippedRules).toEqual([{ rule: "genai-single-call", reason: "profile already has agentic" }]);
    const fix = JSON.parse(await cli(registerMatchCommands, ["match", "--profile", profilePath, "--lens", "fix", "--json"]));
    expect(fix.candidates[0].lensRules).toEqual(["gap-no-dlq"]);
  });
  it("keeps every citation field, including note, in profileEvidence", async () => {
    const fix = JSON.parse(await cli(registerMatchCommands, ["match", "--profile", profilePath, "--lens", "fix", "--json"]));
    expect(fix.candidates[0].reasons.find((reason: { kind: string }) => reason.kind === "pillarGap").profileEvidence).toEqual(evidence);
  });
  it("adds abstracts to each candidate under --include-abstracts", async () => {
    const fix = JSON.parse(await cli(registerMatchCommands, ["match", "--profile", profilePath, "--lens", "fix", "--include-abstracts", "--json"]));
    expect(fix.candidates[0].abstract).toMatch(/dead-letter queue/);
  });
  it("shows level, lens rules and skipped paths in human output", async () => {
    const human = await cli(registerMatchCommands, ["match", "--profile", profilePath, "--lens", "fix"]);
    expect(human).toContain("300 - Advanced");
    expect(human).toContain("Rules: gap-no-dlq");
    const next = await cli(registerMatchCommands, ["match", "--profile", profilePath, "--lens", "next-level"]);
    expect(next).toContain("Skipped: genai-single-call (profile already has agentic)");
  });
  it("profile validate --json prints the validate_profile report", async () => {
    const fromCli = JSON.parse(await cli(registerProfileCommands, ["profile", "validate", profilePath, "--json"]));
    expect(fromCli).toEqual(await mcp("validate_profile", { profile }));
    expect(Object.keys(fromCli).sort()).toEqual(["counts", "omitted", "patterns", "services", "truncated", "unresolvedServices"]);
  });
  it("profile validate prints each service with its catalog name or unresolved, and the pattern names", async () => {
    const human = await cli(registerProfileCommands, ["profile", "validate", profilePath]);
    expect(human).toContain("lambda -> AWS Lambda");
    expect(human).toContain("sns -> unresolved");
    expect(human).toContain("Patterns: gap-no-dlq, genai-single-call, agentic");
  });
});
