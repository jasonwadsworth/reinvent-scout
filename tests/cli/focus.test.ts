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

  it("prints the map grouped, with each topic's id, note, code and goals with session counts", async () => {
    const { text } = await run(["profile", "map", "--profile", file]);
    expect(text).toContain("Services:\n  service:AWS Lambda -- Every handler runs on Lambda");
    expect(text).toContain("    Your code: app/fn.ts:3, app/fn2.ts:4");
    expect(text).toContain("    understand (1 session), deepen (");
    expect(text).toContain("Patterns:\n  pattern:serverless -- No servers");
    expect(text).toContain("Gaps:\n  gap:gap-no-dlq (Reliability) -- the queue has no dead-letter queue");
    expect(text).toContain("    improve (1 session)");
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
      [["--focus", "DynamoDB:deepen", "--lens", "all"], /cannot be used together/],
      [["--per-topic", "3"], /needs --focus/],
      [["--focus", "DynamoDB:deepen", "--per-topic", "11"], /from 1 to 10/],
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
    expect(text).toMatch(/ambiguous: service:AWS Lambda, pattern:lambda/);
  });
});
