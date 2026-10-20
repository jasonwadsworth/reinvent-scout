import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/aws/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { matchFocus } from "../../src/match/focus.js";
import { buildFocusResponse } from "../../src/match/response.js";
import { resolveProfile } from "../../src/profile/profile.js";
import { catalogServiceNames } from "../../src/catalog/query.js";
import { buildServiceAliasIndex } from "../../src/catalog/service-aliases.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { OUTPUT_BUDGET_BYTES } from "../../src/commands/output-budget.js";

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

type CommandResult = Awaited<ReturnType<typeof callCommand>>;
const textOf = (result: CommandResult): string => result.text;

describe("map_profile and match_sessions with a focus", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: CATALOG, index: CATALOG.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: CATALOG.length, count: CATALOG.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  });
  afterEach(() => { home.cleanup(); });
  const run = (name: "map_profile" | "match_sessions", args: Record<string, unknown>, storeRoot = home.path) => callCommand(name, args, { storeRoot });

  it("returns the map: topics with ids, evidence and the goals with their session counts", async () => {
    const result = await run("map_profile", { profile: PROFILE });
    expect(result.isError).not.toBe(true);
    const map = JSON.parse(textOf(result));
    expect(map.services[0]).toMatchObject({ id: "service:AWS Lambda", goals: [{ goal: "understand", sessions: 1 }, { goal: "deepen" }] });
    expect(map.gaps[0]).toMatchObject({ id: "gap:gap-no-dlq", pillar: "Reliability", goals: [{ goal: "improve", sessions: 1 }] });
  });

  it("lists a pattern that is a service's short name after that service, and an unmatched one last", async () => {
    const ECS = "Amazon Elastic Container Service (Amazon ECS)";
    const catalog = [session("ECS200", "Running containers on ECS", { services: [ECS], abstract: "Run containers." })];
    writeCatalog({ raw: catalog, index: catalog.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: 1, count: 1, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const profile = { ...PROFILE, services: [{ name: ECS, evidence: [cite("svc.ts", 2)] }], patterns: [{ name: "zz-unmatched", evidence: [cite("z.ts", 1)] }, { name: "ecs", evidence: [cite("svc.ts", 2)] }] };
    const map = JSON.parse(textOf(await run("map_profile", { profile })));
    expect(map.patterns.map((topic: { id: string }) => topic.id)).toEqual(["pattern:ecs", "pattern:zz-unmatched"]);
    const reversed = JSON.parse(textOf(await run("map_profile", { profile: { ...profile, patterns: [...profile.patterns].reverse() } })));
    expect(reversed.patterns.map((topic: { id: string }) => topic.id)).toEqual(["pattern:ecs", "pattern:zz-unmatched"]);
  });

  it("holds the map to the 24 KiB budget by trimming each topic's evidence, however much the profile cites", async () => {
    const evidence = (i: number) => Array.from({ length: 10 }, (_, n) => ({ repo: "app", file: `src/very/long/path/to/service-${i}/module-${n}.ts`, line: n + 1, note: "a long note about this place ".repeat(4) }));
    const services = Array.from({ length: 40 }, (_, i) => ({ name: i === 0 ? "AWS Lambda" : `Example Synthetic Cloud Service Number ${i} For Response Size Testing`, evidence: evidence(i) }));
    const result = await run("map_profile", { profile: { ...PROFILE, services } });
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    expect(JSON.parse(result.text).services[0].evidence.length).toBeLessThan(10);
  });

  it("reports a bad profile and a missing catalog as command errors", async () => {
    const bad = await run("map_profile", { profile: { schemaVersion: 1 } });
    expect(bad.isError).toBe(true);
    const empty = createTempHome();
    const result = await run("map_profile", { profile: PROFILE }, empty.path);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No catalog has been imported/);
    empty.cleanup();
  });

  it("match_sessions with a focus returns the shared focus response", async () => {
    const focus = [{ topic: "service:Amazon DynamoDB", goal: "understand" }, { topic: "gap:gap-no-dlq", goal: "improve" }];
    const result = await run("match_sessions", { profile: PROFILE, focus, perTopic: 3 });
    expect(result.isError).not.toBe(true);
    const response = JSON.parse(textOf(result));
    const resolved = resolveProfile(PROFILE, buildServiceAliasIndex(catalogServiceNames({ storeRoot: home.path })));
    const expected = JSON.parse(JSON.stringify(buildFocusResponse(matchFocus(resolved, { storeRoot: home.path }, focus as never, { perTopic: 3 }))));
    expect(response).toEqual(expected);
    expect(response.results.map((entry: { candidates: Array<{ code: string }> }) => entry.candidates.map(found => found.code))).toEqual([["DDB100"], ["DLQ300"]]);
  });

  it("refuses a focus together with a lens, a perTopic without a focus, an unknown topic, and a goal that does not apply", async () => {
    const call = async (args: Record<string, unknown>) => { const r = await run("match_sessions", { profile: PROFILE, ...args }); return { error: r.isError, text: textOf(r) }; };
    const focus = [{ topic: "service:AWS Lambda", goal: "deepen" }];
    expect(await call({ focus, lens: "all" })).toMatchObject({ error: true, text: expect.stringMatching(/focus.*lens/i) });
    expect(await call({ focus, limit: 5 })).toMatchObject({ error: true, text: expect.stringMatching(/focus and limit/) });
    expect(await call({ perTopic: 3 })).toMatchObject({ error: true, text: expect.stringMatching(/perTopic/) });
    expect(await call({ focus: [{ topic: "service:Nope", goal: "deepen" }] })).toMatchObject({ error: true, text: expect.stringMatching(/Unknown topic "service:Nope"/) });
    expect(await call({ focus: [{ topic: "service:AWS Lambda", goal: "improve" }] })).toMatchObject({ error: true, text: expect.stringMatching(/does not apply/) });
    expect(await call({ focus: [] })).toMatchObject({ error: true });
    expect(await call({ focus: Array.from({ length: 7 }, () => focus[0]) })).toMatchObject({ error: true });
    expect(await call({ focus, perTopic: 4 })).toMatchObject({ error: true });
  });

  it("keeps the focus response within the 24 KiB budget at six choices of the most sessions, three each, and defaults to three", async () => {
    const big = [
      ...Array.from({ length: 40 }, (_, i) => session(`LAM${String(i).padStart(3, "0")}`, `Lambda deep dive ${i}`, { abstract: `Lambda ${"detail ".repeat(60)}` })),
      ...Array.from({ length: 40 }, (_, i) => session(`DDB${String(i).padStart(3, "0")}`, `DynamoDB deep dive ${i}`, { abstract: `DynamoDB ${"detail ".repeat(60)}` })),
    ];
    writeCatalog({ raw: big, index: big.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: big.length, count: big.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const profile = { ...PROFILE, services: [{ name: "AWS Lambda", usage: "u ".repeat(150), evidence: Array.from({ length: 30 }, (_, i) => ({ repo: "app", file: `f${i}.ts`, line: i + 1, note: "n".repeat(100) })) }, ...PROFILE.services.slice(1)] };
    const focus = [{ topic: "service:AWS Lambda", goal: "deepen" }, { topic: "service:AWS Lambda", goal: "understand" }, { topic: "service:Amazon DynamoDB", goal: "deepen" }, { topic: "service:Amazon DynamoDB", goal: "understand" }, { topic: "gap:gap-no-dlq", goal: "improve" }, { topic: "service:AWS Lambda", goal: "deepen" }];
    const result = await run("match_sessions", { profile, focus, perTopic: 3 });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
    const response = JSON.parse(textOf(result));
    expect(response.results).toHaveLength(6);
    expect(response.results[0].candidates.length + response.results[2].candidates.length).toBeGreaterThan(0);
    expect(response.rankingReasonsOmitted).toBe(true);
    const byDefault = JSON.parse(textOf(await run("match_sessions", { profile, focus })));
    expect(Math.max(...byDefault.results.map((entry: { candidates: unknown[] }) => entry.candidates.length))).toBeLessThanOrEqual(3);
  });
});
