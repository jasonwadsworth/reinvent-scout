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
    { name: "AWS Lambda", evidence: [cite("fn.ts", 3)] },
    { name: "Amazon DynamoDB", evidence: [cite("db.ts", 9)] },
  ],
  patterns: [{ name: "gap-no-dlq", note: "Not evident in the cited scope: no dead-letter queue.", evidence: [cite("q.ts", 1)] }],
};
const session = (code: string, title: string, level: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title, level, type: "Breakout session", ...extra });
const CATALOG = [
  session("DDB100", "Getting started with DynamoDB", "100 - Foundational"),
  session("DDB300", "DynamoDB data modeling", "300 - Advanced"),
  session("DDB400", "DynamoDB at the limit", "400 - Expert"),
  session("LAM200", "Lambda basics", "200 - Intermediate"),
  session("LAM400", "Lambda at scale", "400 - Expert"),
  session("LAM500", "Lambda internals", "500 - Distinguished"),
  session("DLQ400", "Dead-letter queues at scale", "400 - Expert", { services: ["AWS Lambda", "Amazon DynamoDB"], abstract: "Recover with dead-letter queues and redrive." }),
];

describe("--level on match and profile map", () => {
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
  const json = async (args: string[]) => JSON.parse((await run([...args, "--json"])).text);

  it("lists only sessions in the range, for each lens, and echoes the filter", async () => {
    for (const lens of ["all", "fix"]) {
      const response = await json(["match", "--profile", file, "--lens", lens, "--level", "400-500"]);
      expect(response.candidates.length, lens).toBeGreaterThan(0);
      for (const candidate of response.candidates) expect([400, 500], lens).toContain(candidate.levelBand);
      expect(response.preferences).toEqual({ levels: { min: 400, max: 500 } });
    }
    expect((await json(["match", "--profile", file])).preferences).toBeUndefined();
  });

  it("takes a single band, and refuses a bad one", async () => {
    const response = await json(["match", "--profile", file, "--level", "400"]);
    expect(response.candidates.map((candidate: { levelBand: number }) => candidate.levelBand)).toEqual(response.candidates.map(() => 400));
    for (const bad of ["abc", "500-400", "250", "100-600"]) {
      const { text, exitCode } = await run(["match", "--profile", file, "--level", bad]);
      expect(exitCode, bad).toBe(1);
      expect(text, bad).toMatch(/--level|levels/);
    }
  });

  it("refuses --lens explain outside the introductory levels, naming the way out", async () => {
    const { text, exitCode } = await run(["match", "--profile", file, "--lens", "explain", "--level", "400-500"]);
    expect(exitCode).toBe(1);
    expect(text).toBe("explain lists introductory (100–200) sessions, which is outside 400–500; use deepen or all");
  });

  it("filters a focus and says in the text what the filter emptied", async () => {
    const response = await json(["match", "--profile", file, "--focus", "DynamoDB:deepen,DynamoDB:understand", "--level", "400-500"]);
    expect(response.preferences).toEqual({ levels: { min: 400, max: 500 } });
    expect(response.results[0].candidates.map((candidate: { code: string }) => candidate.code)).toEqual(["DDB400"]);
    expect(response.results[1].reason).toBe("understand lists introductory (100–200) sessions, which is outside 400–500; use deepen");
    const { text } = await run(["match", "--profile", file, "--focus", "DynamoDB:understand", "--level", "400-500"]);
    expect(text).toContain("No sessions: understand lists introductory (100–200) sessions, which is outside 400–500; use deepen");
  });

  it("says the filter, and what it emptied, in the text of a plain match", async () => {
    const { text } = await run(["match", "--profile", file, "--lens", "fix", "--level", "100-200"]);
    expect(text).toMatch(/^No matching sessions found\.\n\d+ sessions? match(es)?, none at 100–200/);
    const shown = await run(["match", "--profile", file, "--level", "400-500"]);
    expect(shown.text.split("\n")[0]).toBe("Only sessions at level 400–500.");
  });

  it("filters the map, shows the filter, and counts what is left", async () => {
    const map = await json(["profile", "map", "--profile", file, "--level", "400-500"]);
    expect(map.preferences).toEqual({ levels: { min: 400, max: 500 } });
    const lambda = map.services.find((topic: { id: string }) => topic.id === "service:AWS Lambda");
    expect(lambda.goals).toEqual([{ goal: "understand", sessions: 0, reason: "understand lists introductory (100–200) sessions, which is outside 400–500; use deepen" }, expect.objectContaining({ goal: "deepen", sessions: 2 })]);
    const { text } = await run(["profile", "map", "--profile", file, "--level", "400-500"]);
    expect(text.split("\n")[0]).toBe("Only sessions at level 400–500.");
    expect(text).toContain("deepen (2 sessions)");
  });
});
