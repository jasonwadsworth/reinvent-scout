import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registerCatalogCommands } from "../../src/cli/commands/catalog.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const s = (code: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId: code, abbreviation: code, title: code, level: "300 - Advanced", type: "Breakout session", ...extra });
const CATALOG: Session[] = [
  s("A1", { venue: "MGM Grand", topics: ["Serverless"] }),
  s("B1", { venue: "MGM Grand", type: "Chalk talk", topics: ["Databases"] }),
  s("C1", { venue: "Venetian", type: "Chalk talk", level: "400 - Expert" }),
  ...Array.from({ length: 20 }, (_, i) => s(`T${i}`, { topics: [`Topic ${String(i).padStart(2, "0")}`] })),
];

describe("catalog filters", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: CATALOG, index: CATALOG.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1, totalCount: CATALOG.length, count: CATALOG.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
    process.exitCode = 0;
  });
  afterEach(() => { home.cleanup(); process.exitCode = 0; });
  async function run(args: string[]): Promise<{ text: string; exitCode: number }> {
    const printed: string[] = [];
    const program = new Command().exitOverride();
    registerCatalogCommands(program, { resolveStoreRoot: () => home.path, print: (message: string) => { printed.push(message); } });
    await program.parseAsync(["node", "reinvent-scout", "catalog", "filters", ...args]);
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { text: printed.join("\n"), exitCode };
  }

  it("prints one field's values with counts, all of them", async () => {
    const { text } = await run(["--field", "venue"]);
    expect(text).toBe("venue (2 values):\n  MGM Grand  2\n  Venetian  1");
    const topics = (await run(["--field", "topic"])).text.split("\n");
    expect(topics[0]).toBe("topic (22 values):");
    expect(topics).toHaveLength(23);
  });

  it("prints every field, a short list of each with how to see the rest", async () => {
    const { text } = await run([]);
    for (const field of ["level", "format", "venue", "day", "topic", "area", "industry", "role"]) expect(text).toContain(`${field} (`);
    expect(text).toContain("level (2 values):\n  300  22\n  400  1");
    expect(text).toContain("  ... and 7 more (--field topic)");
  });

  it("prints the same object the MCP tool returns, as JSON", async () => {
    const all = JSON.parse((await run(["--json"])).text);
    expect(all.fields.venue).toEqual({ total: 2, values: [{ value: "MGM Grand", count: 2 }, { value: "Venetian", count: 1 }] });
    expect(all.fields.topic.values).toHaveLength(22);
    expect(Object.keys(JSON.parse((await run(["--field", "format", "--json"])).text).fields)).toEqual(["format"]);
  });

  it("refuses an unknown field, and says the catalog is missing", async () => {
    const bad = await run(["--field", "colour"]);
    expect(bad).toMatchObject({ exitCode: 1, text: expect.stringContaining('Unknown field "colour"') });
    home.cleanup();
    home = createTempHome();
    const none = await run([]);
    expect(none.exitCode).toBe(1);
    expect(none.text).toMatch(/catalog/i);
  });
});
