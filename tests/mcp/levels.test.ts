import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { catalogServiceNames } from "../../src/catalog/query.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { matchFocus } from "../../src/match/focus.js";
import { mapProfile } from "../../src/match/map.js";
import { matchSessionsDetailed } from "../../src/match/match.js";
import { buildFocusResponse, buildMapResponse, buildMatchResponse } from "../../src/match/response.js";
import { resolveProfile } from "../../src/profile/profile.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line: number) => ({ repo: "app", file, line });
const PROFILE = {
  schemaVersion: 1, repos: [{ root: "app", languages: [] }],
  services: [{ name: "AWS Lambda", evidence: [cite("fn.ts", 3)] }, { name: "Amazon DynamoDB", evidence: [cite("db.ts", 9)] }],
  patterns: [{ name: "gap-no-dlq", note: "Not evident in the cited scope: no dead-letter queue.", evidence: [cite("q.ts", 1)] }],
};
const session = (code: string, title: string, level: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level, type: "Breakout session", ...extra });
const CATALOG = [
  session("DDB100", "Getting started with DynamoDB", "100 - Foundational"),
  session("DDB400", "DynamoDB at the limit", "400 - Expert"),
  session("LAM200", "Lambda basics", "200 - Intermediate"),
  session("LAM500", "Lambda internals", "500 - Distinguished"),
  session("CHK400", "Data at scale", "400 - Expert", { type: "Chalk talk", services: ["Amazon DynamoDB"], abstract: "You will use DynamoDB tables." }),
  session("WRK400", "Hands-on tables and indexes", "400 - Expert", { type: "Workshop", services: ["Amazon DynamoDB"], abstract: "You will use DynamoDB tables." }),
  session("DLQ400", "Dead-letter queues at scale", "400 - Expert", { services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover with dead-letter queues and redrive." }),
];
const HIGH = { levels: { min: 400, max: 500 } };

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string => (result.content as Array<{ text: string }>)[0]!.text;

describe("preferences on match_sessions and map_profile", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: CATALOG, index: CATALOG.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: CATALOG.length, count: CATALOG.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  });
  afterEach(() => { home.cleanup(); });
  async function client(): Promise<Client> {
    const server = createMcpServer({ resolveStoreRoot: () => home.path });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
    return c;
  }
  const resolved = () => resolveProfile(PROFILE, buildServiceAliasIndex(catalogServiceNames({ storeRoot: home.path })));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await (await client()).callTool({ name, arguments: { profile: PROFILE, ...args } });
    return { error: result.isError === true, text: textOf(result) };
  };

  it("match_sessions filters every lens, and equals the CLI's response", async () => {
    for (const lens of ["all", "fix"] as const) {
      const { text } = await call("match_sessions", { lens, preferences: HIGH });
      const response = JSON.parse(text);
      expect(response.candidates.length, lens).toBeGreaterThan(0);
      for (const candidate of response.candidates) expect([400, 500], lens).toContain(candidate.levelBand);
      expect(response.preferences).toEqual(HIGH);
      const expected = buildMatchResponse(matchSessionsDetailed(resolved(), { storeRoot: home.path }, { lens, limit: 25, preferences: HIGH }), 25);
      expect(response).toEqual(JSON.parse(JSON.stringify(expected)));
    }
  });

  it("says in the response when the range left nothing of a result that has sessions", async () => {
    const response = JSON.parse((await call("match_sessions", { lens: "fix", preferences: { levels: { min: 100, max: 200 } } })).text);
    expect(response).toMatchObject({ candidates: [], preferences: { levels: { min: 100, max: 200 } }, reason: expect.stringMatching(/^\d+ sessions? match(es)?, none at 100\u2013200$/) });
  });

  it("keeps the echoed preferences when the map is trimmed to the budget", () => {
    const map = mapProfile(resolved(), { storeRoot: home.path }, { preferences: HIGH });
    expect(buildMapResponse(map, () => false).preferences).toEqual(HIGH);
    expect(buildMapResponse(map, value => JSON.stringify(value).length < JSON.stringify(map).length).preferences).toEqual(HIGH);
  });

  it("a focus honors them and echoes them", async () => {
    const focus = [{ topic: "service:Amazon DynamoDB", goal: "deepen" }, { topic: "service:Amazon DynamoDB", goal: "understand" }];
    const response = JSON.parse((await call("match_sessions", { focus, preferences: HIGH })).text);
    expect(response.results[0].candidates.map((entry: { code: string }) => entry.code)).toEqual(["DDB400"]);
    expect(response.results[1]).toMatchObject({ total: 0, reason: expect.stringContaining("outside 400–500") });
    expect(response.preferences).toEqual(HIGH);
    expect(response).toEqual(JSON.parse(JSON.stringify(buildFocusResponse(matchFocus(resolved(), { storeRoot: home.path }, focus as never, { perTopic: 3, preferences: HIGH })))));
  });

  it("map_profile counts under them, echoes them, and equals the CLI's map", async () => {
    const map = JSON.parse((await call("map_profile", { preferences: HIGH })).text);
    expect(map.preferences).toEqual(HIGH);
    expect(map.services.find((topic: { id: string }) => topic.id === "service:AWS Lambda").goals.find((goal: { goal: string }) => goal.goal === "deepen").sessions).toBe(1);
    expect(map).toEqual(JSON.parse(JSON.stringify(buildMapResponse(mapProfile(resolved(), { storeRoot: home.path }, { preferences: HIGH })))));
    expect(JSON.parse((await call("map_profile", {})).text).preferences).toBeUndefined();
  });

  it("refuses a bad range, explain outside the introductory levels, and unknown preference keys", async () => {
    expect(await call("match_sessions", { preferences: { levels: { min: 500, max: 400 } } })).toMatchObject({ error: true, text: expect.stringMatching(/min must not be above max/) });
    expect(await call("match_sessions", { preferences: { levels: { min: 250, max: 400 } } })).toMatchObject({ error: true });
    expect(await call("map_profile", { preferences: { levels: { min: 0, max: 400 } } })).toMatchObject({ error: true });
    expect(await call("match_sessions", { lens: "explain", preferences: HIGH })).toMatchObject({ error: true, text: expect.stringContaining("explain lists introductory (100–200) sessions, which is outside 400–500; use deepen or all") });
    expect(await call("match_sessions", { preferences: { colour: "red" } })).toMatchObject({ error: true });
  });

  it("takes format rules on both tools, resolves the type names, and refuses a bad one", async () => {
    const formats = [{ type: "chalk", action: "prefer" }, { type: "breakout session", action: "avoid", levels: { min: 300, max: 500 } }];
    const matched = JSON.parse((await call("match_sessions", { preferences: { formats } })).text);
    expect(matched.preferences).toEqual({ formats: [{ type: "Chalk talk", action: "prefer" }, { type: "Breakout session", action: "avoid", levels: { min: 300, max: 500 } }] });
    expect(JSON.parse((await call("map_profile", { preferences: { formats } })).text).preferences.formats).toHaveLength(2);
    expect(JSON.parse((await call("match_sessions", { preferences: { formats: [{ type: "workshop", action: "exclude" }] } })).text).candidates.length).toBeGreaterThan(0);
    expect(await call("match_sessions", { preferences: { formats: [{ type: "keynote", action: "avoid" }] } })).toMatchObject({ error: true, text: expect.stringMatching(/Unknown session type "keynote"/) });
    expect(await call("match_sessions", { preferences: { formats: [{ type: "chalk", action: "love" }] } })).toMatchObject({ error: true });
    expect(await call("map_profile", { preferences: { formats: [{ type: "chalk", action: "avoid", extra: 1 }] } })).toMatchObject({ error: true });
  });

  it("describes preferences in both tools", async () => {
    const { tools } = await (await client()).listTools();
    for (const name of ["match_sessions", "map_profile"]) {
      expect(tools.find(tool => tool.name === name)!.description, name).toContain("preferences");
    }
  });
});
