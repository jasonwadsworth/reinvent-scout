import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveTokens, type StoredTokens } from "../../src/auth/token-store.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const NOW = 1_700_000_000_000;

const VALID_TOKENS: StoredTokens = {
  accessToken: "SUPER_SECRET_ACCESS_TOKEN_DO_NOT_LEAK",
  refreshToken: "refresh-abc",
  idToken: "id-abc",
  tokenType: "Bearer",
  expiresIn: 3600,
  obtainedAt: NOW,
};

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: DEFAULT_EVENT_ID,
    syncedAt: NOW,
    totalCount: 0,
    count: 0,
    includedAbstracts: true,
    timezone: null,
    ...overrides,
  };
}

/** Connects a real SDK `Client` to a server built with `createMcpServer(deps)` over an in-memory
 * transport pair -- fast, in-process, and drives the real protocol machinery (the initialize
 * handshake, schema validation, the SDK's own catch-to-isError behaviour), unlike a bare function
 * call into a tool handler would. */
async function connectedClient(deps: Parameters<typeof createMcpServer>[0]): Promise<Client> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("createMcpServer", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("lists exactly the seven expected tools, by name", async () => {
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const tools = await client.listTools();

    // Asserted as a sorted set, not order or count: a swap (e.g. the plan's superseded
    // `profile_repo` for `validate_profile`) leaves the count at seven, so a length-only
    // assertion would pass even with the wrong tool registered. See also
    // tests/mcp/tools-schedule.test.ts's own copy of this check, driven through real per-tool
    // fakes rather than this file's minimal server-behavior harness.
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        "status",
        "catalog_sync",
        "validate_profile",
        "match_sessions",
        "get_schedule",
        "favorite_sessions",
        "unfavorite_session",
      ].sort(),
    );
  });

  it("returns the status tool result as compact json text content, under 30 KB", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    writeCatalog({ raw: [], index: [], meta: sampleMeta() }, { storeRoot: home.path });
    const client = await connectedClient({ resolveStoreRoot: () => home.path, now: () => NOW });

    const result = await client.callTool({ name: "status", arguments: {} });

    expect(result.isError).not.toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(content.type).toBe("text");
    // Compact: no pretty-printing whitespace, and never the token itself.
    expect(content.text).not.toMatch(/\n|  /);
    expect(content.text).not.toContain(VALID_TOKENS.accessToken);
    const parsed = JSON.parse(content.text) as { signedIn: boolean };
    expect(parsed.signedIn).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
  });

  it("returns isError telling the agent it can run auth login itself when no session is stored", async () => {
    // Amendment 3: the skill has shell access, so the MCP status tool's message must say the
    // agent can run the command itself, not defer to a human at a terminal -- task 7's skill
    // content test asserts this exact instruction too, so the wording here is load-bearing beyond
    // just this test.
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({ name: "status", arguments: {} });

    expect(result.isError).toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(content.text).toContain("reinvent-scout auth login");
    expect(content.text).toMatch(/the skill can run it for you/i);
  });

  it("returns isError rather than crashing the server when a tool throws, and the server keeps working afterward", async () => {
    let shouldThrow = true;
    const client = await connectedClient({
      resolveStoreRoot: () => {
        if (shouldThrow) {
          throw new Error("boom: store root resolution exploded");
        }
        return home.path;
      },
    });

    const result = await client.callTool({ name: "status", arguments: {} });
    expect(result.isError).toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(content.text).toContain("boom: store root resolution exploded");

    // The server itself is still alive and answering -- one tool call throwing must not take the
    // whole process down.
    shouldThrow = false;
    const second = await client.callTool({ name: "status", arguments: {} });
    expect(second.isError).toBe(true); // still no session stored, but no crash this time either
  });

  it("rejects a tool call whose arguments fail the input schema", async () => {
    const client = await connectedClient({ resolveStoreRoot: () => home.path });

    const result = await client.callTool({ name: "status", arguments: { unexpected: "prop" } });

    expect(result.isError).toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(content.text).toMatch(/unrecognized|invalid|validation/i);
  });

  it("writes nothing to stdout, even when a tool logs a warning about a missing catalog", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    // No writeCatalog call -- signed in, but nothing synced, which is exactly the condition
    // status's own diagnostic logging (stderr, never stdout) fires on.
    const client = await connectedClient({ resolveStoreRoot: () => home.path, now: () => NOW });

    const original = process.stdout.write.bind(process.stdout);
    const calls: unknown[] = [];
    process.stdout.write = ((...args: unknown[]) => {
      calls.push(args);
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = await client.callTool({ name: "status", arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      process.stdout.write = original;
    }

    // This in-process capture is real but partial (see tests/mcp/stdout-purity.test.ts for why):
    // it proves this process's own direct process.stdout.write calls, if any existed, would be
    // caught, but it cannot see console.* output at all (Node's Console holds its own stream
    // reference) or a dependency writing straight to fd 1. Kept for speed; never treated as the
    // guard on its own.
    expect(calls).toEqual([]);
  });
});
