import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { matchFocus } from "../../src/match/focus.js";
import { buildFocusResponse } from "../../src/match/response.js";
import { resolveProfile } from "../../src/profile/profile.js";
import { catalogServiceNames } from "../../src/catalog/query.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { McpToolDeps } from "../../src/mcp/tools.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line: number) => ({ repo: "app", file, line });
const PROFILE = {
  schemaVersion: 1, repos: [{ root: "app", languages: [] }],
  services: [{ name: "AWS Lambda", evidence: [cite("fn.ts", 3), cite("fn2.ts", 4)] }, { name: "Amazon DynamoDB", evidence: [cite("db.ts", 9)] }],
  patterns: [{ name: "gap-no-dlq", note: "Not evident in the cited scope: no dead-letter queue.", evidence: [cite("q.ts", 1)] }],
};
const session = (code: string, title: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level: "200 - Intermediate", type: "Breakout session", ...extra });
const CATALOG = [
  session("DDB100", "Getting started with DynamoDB", { level: "100 - Foundational" }),
  session("LAM200", "Lambda basics"),
  session("DLQ300", "Dead-letter queues in depth", { level: "300 - Advanced", services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover with dead-letter queues and redrive." }),
];

async function connect(deps: McpToolDeps): Promise<Client> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string => (result.content as Array<{ text: string }>)[0]!.text;

describe("map_profile and match_sessions with a focus", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: CATALOG, index: CATALOG.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: CATALOG.length, count: CATALOG.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  });
  afterEach(() => { home.cleanup(); });
  const client = () => connect({ resolveStoreRoot: () => home.path });

  it("lists map_profile among the tools", async () => {
    const { tools } = await (await client()).listTools();
    expect(tools.map(tool => tool.name)).toContain("map_profile");
    expect(tools.find(tool => tool.name === "map_profile")!.description).toContain("match_sessions");
  });

  it("returns the map: topics with ids, evidence and the goals with their session counts", async () => {
    const result = await (await client()).callTool({ name: "map_profile", arguments: { profile: PROFILE } });
    expect(result.isError).not.toBe(true);
    const map = JSON.parse(textOf(result));
    expect(map.services[0]).toMatchObject({ id: "service:AWS Lambda", goals: [{ goal: "understand", sessions: 1 }, { goal: "deepen" }] });
    expect(map.gaps[0]).toMatchObject({ id: "gap:gap-no-dlq", pillar: "Reliability", goals: [{ goal: "improve", sessions: 1 }] });
  });

  it("reports a bad profile and a missing catalog as tool errors", async () => {
    const bad = await (await client()).callTool({ name: "map_profile", arguments: { profile: { schemaVersion: 1 } } });
    expect(bad.isError).toBe(true);
    const empty = createTempHome();
    const none = await connect({ resolveStoreRoot: () => empty.path });
    const result = await none.callTool({ name: "map_profile", arguments: { profile: PROFILE } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/catalog_sync/);
    empty.cleanup();
  });

  it("match_sessions with a focus returns the shared focus response, equal to what the CLI prints", async () => {
    const focus = [{ topic: "service:Amazon DynamoDB", goal: "understand" }, { topic: "gap:gap-no-dlq", goal: "improve" }];
    const result = await (await client()).callTool({ name: "match_sessions", arguments: { profile: PROFILE, focus, perTopic: 3 } });
    expect(result.isError).not.toBe(true);
    const response = JSON.parse(textOf(result));
    const resolved = resolveProfile(PROFILE, buildServiceAliasIndex(catalogServiceNames({ storeRoot: home.path })));
    const expected = JSON.parse(JSON.stringify(buildFocusResponse(matchFocus(resolved, { storeRoot: home.path }, focus as never, { perTopic: 3 }))));
    expect(response).toEqual(expected);
    expect(response.results.map((entry: { candidates: Array<{ code: string }> }) => entry.candidates.map(found => found.code))).toEqual([["DDB100"], ["DLQ300"]]);
  });

  it("refuses a focus together with a lens, a perTopic without a focus, an unknown topic, and a goal that does not apply", async () => {
    const c = await client();
    const call = async (args: Record<string, unknown>) => { const r = await c.callTool({ name: "match_sessions", arguments: { profile: PROFILE, ...args } }); return { error: r.isError === true, text: textOf(r) }; };
    const focus = [{ topic: "service:AWS Lambda", goal: "deepen" }];
    expect(await call({ focus, lens: "all" })).toMatchObject({ error: true, text: expect.stringMatching(/focus.*lens/i) });
    expect(await call({ perTopic: 3 })).toMatchObject({ error: true, text: expect.stringMatching(/perTopic/) });
    expect(await call({ focus: [{ topic: "service:Nope", goal: "deepen" }] })).toMatchObject({ error: true, text: expect.stringMatching(/Unknown topic "service:Nope"/) });
    expect(await call({ focus: [{ topic: "service:AWS Lambda", goal: "improve" }] })).toMatchObject({ error: true, text: expect.stringMatching(/does not apply/) });
    expect(await call({ focus: [] })).toMatchObject({ error: true });
    expect(await call({ focus: Array.from({ length: 7 }, () => focus[0]) })).toMatchObject({ error: true });
    expect(await call({ focus, perTopic: 11 })).toMatchObject({ error: true });
  });

  it("keeps the focus response within the 30 KB budget at six choices of ten sessions", async () => {
    const big = [
      ...Array.from({ length: 40 }, (_, i) => session(`LAM${String(i).padStart(3, "0")}`, `Lambda deep dive ${i}`, { abstract: `Lambda ${"detail ".repeat(60)}` })),
      ...Array.from({ length: 40 }, (_, i) => session(`DDB${String(i).padStart(3, "0")}`, `DynamoDB deep dive ${i}`, { abstract: `DynamoDB ${"detail ".repeat(60)}` })),
    ];
    writeCatalog({ raw: big, index: big.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: big.length, count: big.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const profile = { ...PROFILE, services: [{ name: "AWS Lambda", usage: "u ".repeat(150), evidence: Array.from({ length: 30 }, (_, i) => ({ repo: "app", file: `f${i}.ts`, line: i + 1, note: "n".repeat(100) })) }, ...PROFILE.services.slice(1)] };
    const focus = [{ topic: "service:AWS Lambda", goal: "deepen" }, { topic: "service:AWS Lambda", goal: "understand" }, { topic: "service:Amazon DynamoDB", goal: "deepen" }, { topic: "service:Amazon DynamoDB", goal: "understand" }, { topic: "gap:gap-no-dlq", goal: "improve" }, { topic: "service:AWS Lambda", goal: "deepen" }];
    const result = await (await client()).callTool({ name: "match_sessions", arguments: { profile, focus, perTopic: 10 } });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(30 * 1024);
    const response = JSON.parse(textOf(result));
    expect(response.results).toHaveLength(6);
    expect(response.results[0].candidates.length + response.results[2].candidates.length).toBeGreaterThan(0);
    expect(response.rankingReasonsOmitted).toBe(true);
  });
});
