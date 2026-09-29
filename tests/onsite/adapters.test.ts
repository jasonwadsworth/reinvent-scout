import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { registerScheduleCommands } from "../../src/cli/commands/schedule.js";
import { registerMcpCommand } from "../../src/cli/commands/mcp.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempHome } from "../helpers/temp-home.js";
import type { NearbyResult } from "../../src/onsite/recommend.js";
afterEach(() => vi.unstubAllEnvs());
it("MCP default resolver and CLI config reads create no store", async () => {
  const home = createTempHome(); const root = join(home.path, "missing");
  try {
    vi.stubEnv("REINVENT_SCOUT_HOME", root);
    const program = new Command();
    registerMcpCommand(program, { runServer: async deps => { expect(deps.resolveStoreRoot()).toBe(root); } });
    await program.parseAsync(["node", "cli", "mcp"]); expect(existsSync(root)).toBe(false);
    const cli = new Command(); registerScheduleCommands(cli, { print: () => {} });
    await cli.parseAsync(["node", "cli", "schedule", "onsite-config"]); expect(existsSync(root)).toBe(false);
  } finally { home.cleanup(); }
});
it("documented MCP preferences→confirmed nearby→printed ID reservation agrees with CLI", async () => {
  const home = createTempHome(); const now = Date.parse("2026-12-02T18:00Z");
  const raw = [{ sessionId: "constructor", title: "Useful talk", venue: "MGM Grand", isReservable: true, seatAvailability: "available" as const, sessionTime: { date: "2026-12-02", time: "10:30", length: "30" } }];
  let writes = 0; let reserved: string[] = [];
  try {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: DEFAULT_EVENT_ID, syncedAt: now, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    const api = createApiClient({ getAccessToken: async () => "fixture", fetchFn: async (url, init) => {
      if (init?.method === "POST") { writes++; reserved = JSON.parse(init.body as string).sessionIds; return Response.json({ result: { successful: reserved, failed: [] } }); }
      if (String(url).includes("/sessions/")) return Response.json({ session: raw[0] });
      return Response.json({ schedule: { reserved, favorites: [], personalTime: [] } });
    } });
    const server = createMcpServer({ resolveStoreRoot: () => home.path, buildApiClient: () => api, now: () => now });
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "onsite-docs", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const workflow = readFileSync(new URL("../../skills/reinvent-scout/reference/workflow.md", import.meta.url), "utf8");
    const examples = [...workflow.matchAll(/```json\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]!) as { tool?: string; arguments?: Record<string, unknown> }).filter(x => ["get_onsite_preferences", "set_onsite_preferences", "nearby_sessions"].includes(x.tool ?? ""));
    expect(examples.map(x => x.tool)).toEqual(["get_onsite_preferences", "set_onsite_preferences", "nearby_sessions"]);
    let result!: NearbyResult;
    for (const example of examples) {
      const reply = await client.callTool({ name: example.tool!, arguments: example.arguments! });
      expect(reply.isError).not.toBe(true); expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(30 * 1024);
      if (example.tool === "nearby_sessions") result = JSON.parse((reply.content as Array<{ text: string }>)[0]!.text);
    }
    expect(writes).toBe(0); expect(result.candidates[0]!.sessionId).toBe("constructor");
    const lines: string[] = []; const cli = new Command(); registerScheduleCommands(cli, { resolveStoreRoot: () => home.path, buildApiClient: () => api, now: () => now, print: line => lines.push(line) });
    await cli.parseAsync(["node", "cli", "schedule", "nearby", "--venue", "MGM Grand", "--confirm-venue", "--json"]);
    expect(JSON.parse(lines.pop()!).candidates).toEqual(result.candidates);
    await cli.parseAsync(["node", "cli", "schedule", "nearby", "--venue", "MGM Grand", "--confirm-venue"]);
    expect(lines.join("\n")).toContain("default assumption"); expect(lines.join("\n")).toContain("Band available, live");
    const reply = await client.callTool({ name: "reserve_sessions", arguments: { sessionIds: [result.candidates[0]!.sessionId] } });
    expect(reply.isError).not.toBe(true); expect(writes).toBe(1); expect(reserved).toEqual(["constructor"]);
    await client.close(); await server.close();
  } finally { home.cleanup(); }
});
