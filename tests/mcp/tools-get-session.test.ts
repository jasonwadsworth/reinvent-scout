import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient, type ApiClient } from "../../src/api/client.js";
import type { Session } from "../../src/api/types.js";
import { AuthRequiredError, NotFoundError, NotRegisteredError } from "../../src/core/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const live: Session = { sessionId: "abc123", abbreviation: "ARC330", title: "SaaS agents", abstract: "never returned", isReservable: true, seatAvailability: "unavailable", sessionTime: { date: "2026-12-02", time: "10:30", length: "60" } };

async function connect(storeRoot: string, buildApiClient: () => ApiClient): Promise<Client> {
  const server = createMcpServer({ resolveStoreRoot: () => storeRoot, buildApiClient, now: () => Date.parse("2026-12-01T00:00:00Z") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
const stubClient = (getSession: ApiClient["getSession"]): ApiClient => ({ getSession } as unknown as ApiClient);
const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0]!.text;

describe("get_session tool", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); }); afterEach(() => home.cleanup());

  it("is listed with a strict input schema", async () => {
    const client = await connect(home.path, () => stubClient(async () => live));
    const tool = (await client.listTools()).tools.find(t => t.name === "get_session");
    expect(tool).toBeDefined();
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties).sort()).toEqual(["event", "sessionId"]);
  });
  it("returns the live seat band and bounded fields, never the abstract", async () => {
    const client = await connect(home.path, () => stubClient(async () => live));
    const result = await client.callTool({ name: "get_session", arguments: { sessionId: " abc123 " } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ sessionId: "abc123", abbreviation: "ARC330", title: "SaaS agents", isReservable: true, seatAvailability: "unavailable", fetchedAt: "2026-12-01T00:00:00.000Z" });
    expect(textOf(result)).not.toContain("never returned");
  });
  it("passes the event through", async () => {
    const seen: string[] = [];
    const client = await connect(home.path, () => stubClient(async (event, id) => { seen.push(`${event}:${id}`); return live; }));
    await client.callTool({ name: "get_session", arguments: { sessionId: "abc123", event: "other" } });
    expect(seen).toEqual(["other:abc123"]);
  });
  it("explains that a 404 is not proof the session is gone", async () => {
    const client = await connect(home.path, () => stubClient(async () => { throw new NotFoundError("Session not found."); }));
    const result = await client.callTool({ name: "get_session", arguments: { sessionId: "abc123" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found/i);
    expect(textOf(result)).toMatch(/outage/i);
    expect(textOf(result)).toMatch(/not proof/i);
  });
  it.each([
    [new AuthRequiredError(), /auth login/],
    [new NotRegisteredError("You are not registered for reinvent2026."), /not registered/i],
  ])("maps %s like the other tools", async (error, pattern) => {
    const client = await connect(home.path, () => stubClient(async () => { throw error; }));
    const result = await client.callTool({ name: "get_session", arguments: { sessionId: "abc123" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(pattern);
  });
  it.each([{}, { sessionId: "" }, { sessionId: "x".repeat(129) }, { sessionId: "a", extra: 1 }])("rejects invalid input %j before any read", async args => {
    let reads = 0;
    const client = await connect(home.path, () => stubClient(async () => { reads++; return live; }));
    const result = await client.callTool({ name: "get_session", arguments: args });
    expect(result.isError).toBe(true);
    expect(reads).toBe(0);
  });
  it("never leaks the access token, on success or failure", async () => {
    const token = "tok-SENTINEL-123";
    for (const response of [{ status: 200, json: { session: live } }, { status: 404, json: { message: "Session not found." } }]) {
      const fake = createFakeFetch([response]);
      const client = await connect(home.path, () => createApiClient({ fetchFn: fake.fetch, getAccessToken: async () => token }));
      const result = await client.callTool({ name: "get_session", arguments: { sessionId: "abc123" } });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(fake.calls).toHaveLength(1);
      expect(new Headers(fake.calls[0]!.init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    }
  });
});
