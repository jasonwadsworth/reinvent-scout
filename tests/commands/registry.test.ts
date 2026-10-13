import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registry } from "../../src/commands/registry.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"));

describe("command registry", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: fixture, index: fixture.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1_700_000_000_000, totalCount: fixture.length, count: fixture.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  });
  afterEach(() => home.cleanup());

  it("holds exactly the thirteen commands, each with a description and an object schema", () => {
    expect(Object.keys(registry).sort()).toEqual(["catalog_changes", "catalog_import", "get_onsite_preferences", "list_filters", "lookup_sessions", "map_profile", "match_sessions", "nearby_sessions", "plan_schedule", "search_sessions", "set_onsite_preferences", "status", "validate_profile"]);
    for (const entry of Object.values(registry)) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.inputSchema.type).toBe("object");
    }
  });

  it("gives the same text through the registry as through the MCP tool for the same input", async () => {
    const server = createMcpServer({ resolveStoreRoot: () => home.path });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const profile = { schemaVersion: 1, repos: [{ root: ".", languages: [] }], services: [{ name: "lambda", evidence: [{ repo: ".", file: "a" }] }], patterns: [] };
    for (const [name, input] of [["validate_profile", { profile }], ["list_filters", {}], ["get_onsite_preferences", {}]] as const) {
      const viaMcp = await client.callTool({ name, arguments: input });
      const viaRegistry = await callCommand(name, input, { storeRoot: home.path });
      expect(viaRegistry.text).toBe((viaMcp.content as Array<{ text: string }>)[0]!.text);
      expect(viaRegistry.isError).toBe(viaMcp.isError === true);
    }
  });

  it("reports a command error as text with isError", async () => {
    const result = await callCommand("match_sessions", { profile: { not: "a profile" } }, { storeRoot: home.path });
    expect(result.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });
});
