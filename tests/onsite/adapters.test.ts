import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_EVENT_ID, writeCatalog } from "../../src/catalog/store.js";
import { OUTPUT_BUDGET_BYTES } from "../../src/commands/output-budget.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome } from "../helpers/temp-home.js";
import type { NearbyResult } from "../../src/onsite/recommend.js";
const bundle = new URL("../../plugin/skills/reinvent-scout/scripts/reinvent-scout.mjs", import.meta.url).pathname;
it("get_onsite_preferences through the script creates no store", () => {
  const home = createTempHome(); const root = join(home.path, "missing");
  try {
    const spawned = spawnSync(process.execPath, [bundle, "get_onsite_preferences"], { env: { ...process.env, REINVENT_SCOUT_HOME: root }, encoding: "utf8" });
    expect(spawned.status).toBe(0); expect(existsSync(root)).toBe(false);
  } finally { home.cleanup(); }
});
it("the documented on-site examples run through the commands", async () => {
  const home = createTempHome(); const now = Date.parse("2026-12-02T18:00Z");
  const raw = [{ sessionId: "constructor", title: "Useful talk", venue: "MGM Grand", isReservable: true, seatAvailability: "available" as const, sessionTime: { date: "2026-12-02", time: "10:30", length: "30" } }];
  try {
    writeCatalog({ raw, index: raw.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: DEFAULT_EVENT_ID, syncedAt: now, count: 1, totalCount: 1, includedAbstracts: true, timezone: "America/Los_Angeles" } }, { storeRoot: home.path });
    const workflow = readFileSync(new URL("../../plugin/skills/reinvent-scout/reference/workflow.md", import.meta.url), "utf8");
    const examples = [...workflow.matchAll(/```json\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]!) as { tool?: string; arguments?: Record<string, unknown> }).filter(x => ["get_onsite_preferences", "set_onsite_preferences", "nearby_sessions"].includes(x.tool ?? ""));
    expect(examples.map(x => x.tool)).toEqual(["get_onsite_preferences", "set_onsite_preferences", "nearby_sessions"]);
    // The documented examples run through the registry (the script's commands); nearby takes two calls.
    const opts = { storeRoot: home.path, now: () => now };
    let result!: NearbyResult;
    for (const example of examples) {
      const reply = await callCommand(example.tool as "nearby_sessions", example.arguments, opts);
      expect(reply.isError).toBe(false); expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);
      if (example.tool === "nearby_sessions") {
        const first = JSON.parse(reply.text) as NearbyResult;
        expect(first.refreshIds).toEqual(["constructor"]);
        const second = await callCommand("nearby_sessions", { ...example.arguments, liveSessions: first.refreshIds.map(id => raw.find(s => s.sessionId === id)) }, opts);
        expect(second.isError).toBe(false);
        result = JSON.parse(second.text);
      }
    }
    expect(result.candidates[0]!.sessionId).toBe("constructor");
  } finally { home.cleanup(); }
});
