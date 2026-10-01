import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { listFilters } from "../../src/catalog/filters.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const s = (code: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title: code, level: "300 - Advanced", type: "Breakout session", ...extra });
const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string => (result.content as Array<{ text: string }>)[0]!.text;

describe("list_filters", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });
  const seed = (raw: Session[]) => writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  async function call(args: Record<string, unknown>): Promise<{ error: boolean; text: string }> {
    const server = createMcpServer({ resolveStoreRoot: () => home.path });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "list_filters", arguments: args });
    return { error: result.isError === true, text: textOf(result) };
  }

  it("returns what the CLI's JSON does, with no profile", async () => {
    seed([s("A1", { venue: "MGM Grand", topics: ["Serverless"] }), s("B1", { venue: "MGM Grand", type: "Chalk talk" }), s("C1", { venue: "Venetian" })]);
    const { error, text } = await call({});
    expect(error).toBe(false);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(listFilters({ storeRoot: home.path }, { limit: 40 }))));
    expect(JSON.parse(text).fields.venue.values).toEqual([{ value: "MGM Grand", count: 2 }, { value: "Venetian", count: 1 }]);
    expect(Object.keys(JSON.parse(text).fields)).toEqual(["level", "format", "venue", "day", "topic", "area", "industry", "role"]);
  });

  it("returns one field, and names the fields when asked for one that is not", async () => {
    seed([s("A1", { venue: "MGM Grand" })]);
    expect(Object.keys(JSON.parse((await call({ field: "venue" })).text).fields)).toEqual(["venue"]);
    expect(await call({ field: "colour" })).toMatchObject({ error: true, text: expect.stringContaining("Fields: level, format, venue") });
  });

  it("shortens each field's list and says how many more, with no field asked for", async () => {
    seed(Array.from({ length: 60 }, (_, i) => s(`T${i}`, { topics: [`Topic ${String(i).padStart(2, "0")}`] })));
    const topic = JSON.parse((await call({})).text).fields.topic;
    expect(topic.values).toHaveLength(40);
    expect(topic).toMatchObject({ total: 60, more: 20 });
    expect(JSON.parse((await call({ field: "topic" })).text).fields.topic.values).toHaveLength(60);
  });

  it("stays within the 30 KB budget, however many values a field has", async () => {
    seed(Array.from({ length: 1500 }, (_, i) => s(`T${i}`, { topics: [`A very long topic name number ${i} ${"x".repeat(40)}`] })));
    const { error, text } = await call({ field: "topic" });
    expect(error).toBe(false);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(30 * 1024);
    const topic = JSON.parse(text).fields.topic;
    expect(topic.total).toBe(1500);
    expect(topic.more).toBe(1500 - topic.values.length);
    expect(topic.more).toBeGreaterThan(0);
  });

  it("reports a missing catalog as a tool error", async () => {
    expect(await call({})).toMatchObject({ error: true, text: expect.stringMatching(/catalog_sync/) });
  });
});
