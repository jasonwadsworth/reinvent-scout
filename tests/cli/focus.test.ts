import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registerMatchCommands } from "../../src/cli/commands/match.js";
import { registerProfileCommands } from "../../src/cli/commands/profile.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line: number) => ({ repo: "app", file, line });
const PROFILE = {
  schemaVersion: 1, repos: [{ root: "app", languages: ["typescript"] }],
  services: [
    { name: "AWS Lambda", usage: "Every handler runs on Lambda.", evidence: [cite("fn.ts", 3), cite("fn2.ts", 4)] },
    { name: "Amazon DynamoDB", evidence: [cite("db.ts", 9)] },
  ],
  patterns: [
    { name: "serverless", note: "No servers.", evidence: [cite("app.ts", 5)] },
    { name: "gap-no-dlq", note: "Not evident in the cited scope: the queue has no dead-letter queue.", evidence: [cite("q.ts", 1)] },
  ],
};
const session = (code: string, title: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level: "200 - Intermediate", type: "Breakout session", ...extra });
const CATALOG = [
  session("DDB100", "Getting started with DynamoDB", { level: "100 - Foundational" }),
  session("LAM200", "Lambda basics"),
  session("DLQ300", "Dead-letter queues in depth", { level: "300 - Advanced", services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover with dead-letter queues and redrive." }),
];

describe("profile map and match --focus", () => {
  let home: TempHome;
  let file: string;
  beforeEach(() => {
    home = createTempHome();
    file = join(home.path, "profile.json");
    writeFileSync(file, JSON.stringify(PROFILE));
    writeCatalog({ raw: CATALOG, index: CATALOG.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: CATALOG.length, count: CATALOG.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    process.exitCode = 0;
  });
  afterEach(() => { home.cleanup(); process.exitCode = 0; });

  async function run(args: string[]): Promise<{ text: string; exitCode: number }> {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    const deps = { resolveStoreRoot: () => home.path, print: (message: string) => { printed.push(message); } };
    registerProfileCommands(program, deps);
    registerMatchCommands(program, deps);
    await program.parseAsync(["node", "reinvent-scout", ...args]);
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { text: printed.join("\n"), exitCode };
  }

  it("prints the map grouped: each topic's label and id, note, code, and only the goals that have sessions", async () => {
    const { text } = await run(["profile", "map", "--profile", file]);
    expect(text).toContain("Services:\n  AWS Lambda  [service:AWS Lambda]\n    Every handler runs on Lambda\n");
    expect(text).toContain("    Your code: app/fn.ts:3, app/fn2.ts:4");
    expect(text).toContain("    understand (1 session), deepen (");
    expect(text).toContain("Patterns:\n  serverless  [pattern:serverless]\n    No servers\n");
    expect(text).toContain("Gaps:\n  gap-no-dlq  [gap:gap-no-dlq] (Reliability)\n    the queue has no dead-letter queue");
    expect(text).toContain("    improve (1 session)");
  });

  it("says which platform services the map leaves out and why, only when the profile has some", async () => {
    expect((await run(["profile", "map", "--profile", file])).text).not.toContain("Not shown");
    // A name resolves to its catalog name through the catalog's own service vocabulary.
    const withPlatform = [...CATALOG, session("PLT200", "Platform basics", { services: ["Amazon Simple Storage Service (Amazon S3)", "AWS Key Management Service (AWS KMS)", "AWS Cloud Development Kit (AWS CDK)"] })];
    writeCatalog({ raw: withPlatform, index: withPlatform.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: withPlatform.length, count: withPlatform.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    writeFileSync(file, JSON.stringify({ ...PROFILE, services: [...PROFILE.services, { name: "Amazon S3", evidence: [cite("s3.ts", 1)] }, { name: "AWS KMS", evidence: [cite("k.ts", 1)] }, { name: "AWS CDK", evidence: [cite("cdk.ts", 1)] }] }));
    const { text } = await run(["profile", "map", "--profile", file]);
    expect(text).toContain("Not shown: S3, KMS, CDK (platform services nearly every workload uses; they don't narrow sessions)");
    const json = JSON.parse((await run(["profile", "map", "--profile", file, "--json"])).text);
    expect(json.omittedPlatformServices).toEqual(["S3", "KMS", "CDK"]);
  });

  it("shows a next step's destination, and one line per goal for the topics with nothing instead of a zero on each", async () => {
    const { text } = await run(["profile", "map", "--profile", file]);
    expect(text).toContain("  serverless → containers  [path:serverless]");
    expect(text).not.toContain("(0 sessions)");
    expect(text).toMatch(/Patterns:[\s\S]*No introductory sessions in the catalog for: serverless/);
    expect(text).toContain("No sessions that go deeper in the catalog for: serverless");
  });

  it("gives the closest 300-level session under the goal that has none", async () => {
    const withCognito = [...CATALOG, session("COG300", "Cognito internals", { level: "300 - Advanced" })];
    writeCatalog({ raw: withCognito, index: withCognito.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: withCognito.length, count: withCognito.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    writeFileSync(file, JSON.stringify({ ...PROFILE, services: [...PROFILE.services, { name: "Amazon Cognito", evidence: [cite("auth.ts", 1)] }] }));
    const { text } = await run(["profile", "map", "--profile", file]);
    expect(text).toContain('    closest 300-level for Amazon Cognito: COG300 "Cognito internals"');
  });

  it("prints the map as JSON", async () => {
    const map = JSON.parse((await run(["profile", "map", "--profile", file, "--json"])).text);
    expect(map.services[0]).toMatchObject({ id: "service:AWS Lambda", goals: [{ goal: "understand" }, { goal: "deepen" }] });
    expect(map.gaps[0]).toMatchObject({ id: "gap:gap-no-dlq", pillar: "Reliability" });
  });

  it("lists the sessions per choice with a heading, and a bare label names its topic", async () => {
    const { text } = await run(["match", "--profile", file, "--focus", "DynamoDB:understand,gap-no-dlq:improve"]);
    expect(text).toContain("Understand service:Amazon DynamoDB -- 1 of 1 session");
    expect(text).toContain("DDB100 -- Getting started with DynamoDB");
    expect(text).toContain("Improve gap:gap-no-dlq -- 1 of 1 session");
    expect(text).toContain("DLQ300 -- Dead-letter queues in depth");
    expect(text).toContain("  Why: Covers your gap-no-dlq");
  });

  it("takes the goal into account when a bare label names several topics, and a service's short name", async () => {
    writeFileSync(file, JSON.stringify({ ...PROFILE, services: [...PROFILE.services, { name: "Amazon ECS", evidence: [cite("e.ts", 1)] }], patterns: [...PROFILE.patterns, { name: "ecs", evidence: [cite("e2.ts", 1)] }] }));
    const withEcs = [...CATALOG, session("ECS200", "Amazon ECS basics", { services: ["Amazon Elastic Container Service (Amazon ECS)"] })];
    writeCatalog({ raw: withEcs, index: withEcs.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: withEcs.length, count: withEcs.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const ok = JSON.parse((await run(["match", "--profile", file, "--focus", "ECS:deepen,serverless:improve", "--json"])).text);
    expect(ok.results.map((entry: { topic: string }) => entry.topic)).toEqual(["service:Amazon Elastic Container Service (Amazon ECS)", "path:serverless"]);
  });

  it("notes the later choice a listed session also matches", async () => {
    const shared = [...CATALOG, session("LAM201", "Lambda and DynamoDB together")];
    writeCatalog({ raw: shared, index: shared.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: shared.length, count: shared.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const { text } = await run(["match", "--profile", file, "--focus", "Lambda:deepen,DynamoDB:deepen"]);
    expect(text).toContain("  Also matches: service:Amazon DynamoDB");
  });

  it("says in the map that a next step was already taken, and what it is skipped for", async () => {
    writeFileSync(file, JSON.stringify({ ...PROFILE, patterns: [...PROFILE.patterns, { name: "genai-single-call", evidence: [cite("g.ts", 1)] }, { name: "agentic", evidence: [cite("a.ts", 1)] }] }));
    const { text } = await run(["profile", "map", "--profile", file]);
    expect(text).toContain("Next steps:\n");
    expect(text).toContain("[path:genai-single-call]");
    expect(text).toContain("    skipped: profile already has agentic");
  });

  it("says a choice was emptied by earlier ones, in the text and the JSON", async () => {
    const one = [session("LAM201", "Lambda and DynamoDB together")];
    writeCatalog({ raw: one, index: one.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: 1, count: 1, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const args = ["match", "--profile", file, "--focus", "Lambda:deepen,DynamoDB:deepen"];
    expect((await run(args)).text).toContain("No sessions: all 1 matching session is listed under service:AWS Lambda");
    expect(JSON.parse((await run([...args, "--json"])).text).results[1]).toMatchObject({ total: 1, candidates: [], reason: "all 1 matching session is listed under service:AWS Lambda" });
  });

  it("says why a choice has no sessions", async () => {
    const { text } = await run(["match", "--profile", file, "--focus", "pattern:serverless:understand"]);
    expect(text).toContain("Understand pattern:serverless -- 0 of 0 sessions");
    expect(text).toContain("  No sessions: ");
  });

  it("prints JSON that is the shared focus response, honouring --per-topic", async () => {
    const response = JSON.parse((await run(["match", "--profile", file, "--focus", "Lambda:deepen", "--per-topic", "1", "--json"])).text);
    expect(response).toMatchObject({ truncated: false, omitted: 0 });
    expect(response.results[0]).toMatchObject({ topic: "service:AWS Lambda", goal: "deepen" });
    expect(response.results[0].candidates).toHaveLength(1);
    expect(response.results[0].candidates[0].why.summary).toContain("AWS Lambda");
  });

  it("refuses a bad focus, a goal that does not apply, --lens with --focus, --per-topic alone, and a bad --per-topic", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["--focus", "DynamoDB"], /"<topic>:<goal>"/],
      [["--focus", "DynamoDB:dance"], /goal of understand, deepen, improve/],
      [["--focus", "Nope:deepen"], /Unknown topic "Nope".*service:AWS Lambda/s],
      [["--focus", "DynamoDB:improve"], /does not apply/],
      [["--focus", "DynamoDB:deepen", "--lens", "all"], /--focus and --lens cannot be used together/],
      [["--focus", "DynamoDB:deepen", "--limit", "5"], /--focus and --limit cannot be used together/],
      [["--per-topic", "3"], /needs --focus/],
      [["--focus", "DynamoDB:deepen", "--per-topic", "11"], /--per-topic must be a whole number from 1 to 10/],
    ];
    for (const [args, message] of cases) {
      const { text, exitCode } = await run(["match", "--profile", file, ...args]);
      expect(text, args.join(" ")).toMatch(message);
      expect(exitCode, args.join(" ")).toBe(1);
    }
  });

  it("refuses an ambiguous bare label, naming the candidates", async () => {
    writeFileSync(file, JSON.stringify({ ...PROFILE, patterns: [...PROFILE.patterns, { name: "lambda", evidence: [cite("x.ts", 1)] }] }));
    const { text } = await run(["match", "--profile", file, "--focus", "lambda:deepen"]);
    expect(text).toMatch(/ambiguous for deepen: service:AWS Lambda, pattern:lambda/);
  });
});
