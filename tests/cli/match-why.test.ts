import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registerMatchCommands } from "../../src/cli/commands/match.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const cite = (file: string, line: number) => ({ repo: "tracker", file, line });
const profile = (evidence: Array<ReturnType<typeof cite>>) => ({
  schemaVersion: 1, repos: [{ root: "tracker", languages: [] }],
  services: [{ name: "AWS Lambda", evidence: [cite("fn.ts", 1)] }, { name: "Amazon SQS", evidence: [cite("q.ts", 1)] }],
  patterns: [{ name: "gap-no-dlq", note: "Not evident in the cited scope: the tenant rules set no deadLetterQueue.", evidence }],
});
const dlqTalk: Session = {
  sessionId: "s1", abbreviation: "DLQ301", title: "Recovering failed events", level: "300 - Advanced", type: "Breakout session",
  services: ["AWS Lambda", "Amazon Simple Queue Service (Amazon SQS)"],
  abstract: "Opening. Recover from failed deliveries using dead-letter queues and redrive. Redrive again with dead-letter queues.",
};

describe("match: the why block in the terminal", () => {
  let home: TempHome;
  beforeEach(() => { home = createTempHome(); });
  afterEach(() => { home.cleanup(); });

  async function run(evidence: Array<ReturnType<typeof cite>>, extra: string[] = [], raw: Session[] = [dlqTalk]): Promise<string> {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: raw.length, count: raw.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    const file = join(home.path, "profile.json");
    writeFileSync(file, JSON.stringify(profile(evidence)));
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerMatchCommands(program, { resolveStoreRoot: () => home.path, print: message => { printed.push(message); } });
    await program.parseAsync(["node", "reinvent-scout", "match", "--profile", file, "--lens", "fix", ...extra]);
    return printed.join("\n");
  }

  it("leads with Why, Your code and Session directly under the title line", async () => {
    const lines = (await run([cite("rules.ts", 179), cite("other.ts", 4)])).split("\n");
    expect(lines[0]).toMatch(/^DLQ301 -- Recovering failed events/);
    expect(lines[1]).toBe("  Why: Covers your gap-no-dlq: the tenant rules set no deadLetterQueue.");
    expect(lines[2]).toBe("  Your code: tracker/rules.ts:179, tracker/other.ts:4");
    expect(lines[3]).toBe('  Session: "Recover from failed deliveries using dead-letter queues and redrive."');
    expect(lines[4]).toBe("  Rules: gap-no-dlq");
  });

  it("says how many more places were cut", async () => {
    const text = await run([cite("a.ts", 1), cite("b.ts", 2), cite("c.ts", 3), cite("d.ts", 4), cite("e.ts", 5)]);
    expect(text).toContain("  Your code: tracker/a.ts:1, tracker/b.ts:2, tracker/c.ts:3 (+2 more)");
  });

  it("shows only the rule names by default, not the lens reason or its sources again", async () => {
    const text = await run([cite("rules.ts", 179)]);
    expect(text).toContain("  Rules: gap-no-dlq");
    expect(text).not.toContain("Reliability");
    expect(text).not.toContain("Source:");
    expect(text.match(/rules\.ts:179/g)).toHaveLength(1);
  });

  it("puts the full lens reason, with its sources, after the why under --verbose", async () => {
    const text = await run([cite("rules.ts", 179)], ["--verbose"]);
    expect(text.indexOf("Why:")).toBeLessThan(text.indexOf("gap-no-dlq: Reliability"));
    expect(text).toContain("    Source: tracker/rules.ts:179");
  });

  it("hides ranking reasons unless --verbose is given", async () => {
    const quiet = await run([cite("rules.ts", 179)]);
    expect(quiet).not.toContain("which this session covers");
    expect(quiet).not.toContain("Reliability");
    expect(quiet).not.toContain("Text overlap");
    const verbose = await run([cite("rules.ts", 179)], ["--verbose"]);
    expect(verbose).toContain("Uses AWS Lambda, which this session covers.");
  });

  it("shows Why, Your code and Session for an all candidate, and says it once when it is demoted", async () => {
    const pitch: Session = { ...dlqTalk, sessionId: "s2", abbreviation: "LAM302-S", title: "Run Lambda faster (sponsored by Acme)", abstract: "Nothing more." };
    const text = await run([cite("rules.ts", 179)], ["--lens", "all"], [pitch]);
    const lines = text.split("\n");
    expect(lines[1]).toBe("  Why: Matches your AWS Lambda; ranked lower: sponsored session.");
    expect(lines[2]).toBe("  Your code: tracker/fn.ts:1");
    expect(lines[3]).toBe('  Session: "Run Lambda faster (sponsored by Acme)"');
    expect(lines[4]).toBe("  Offerings:");
    expect(text).not.toContain("Demoted:");
    expect(text.match(/sponsored session/g)).toHaveLength(1);
  });

  it("does not change --json with --verbose, and JSON always keeps the ranking reasons", async () => {
    const plain = JSON.parse(await run([cite("rules.ts", 179)], ["--json"]));
    const verbose = JSON.parse(await run([cite("rules.ts", 179)], ["--json", "--verbose"]));
    expect(verbose).toEqual(plain);
    expect(plain.candidates[0].why.summary).toBe("Covers your gap-no-dlq: the tenant rules set no deadLetterQueue.");
    expect(plain.candidates[0].reasons.map((reason: { kind: string }) => reason.kind)).toContain("service");
  });
});
