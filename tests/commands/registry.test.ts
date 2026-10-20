import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/aws/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { registry, type CommandName } from "../../src/commands/registry.js";
import { callCommand } from "../helpers/call-command.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "..", "plugin", "skills", "reinvent-scout", "scripts", "reinvent-scout.mjs");
const fixture: Session[] = JSON.parse(readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"));

describe("command registry", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome();
    writeCatalog({ raw: fixture, index: fixture.map(buildIndexRecord), meta: { schemaVersion: CURRENT_SCHEMA_VERSION, eventId: "reinvent2026", syncedAt: 1_700_000_000_000, totalCount: fixture.length, count: fixture.length, includedAbstracts: true, timezone: null } }, { storeRoot: home.path });
  });
  afterEach(() => home.cleanup());

  it("holds exactly the thirteen commands, each with a description and an object schema", () => {
    expect(Object.keys(registry).sort()).toEqual(["catalog_changes", "catalog_import", "get_onsite_preferences", "list_filters", "lookup_sessions", "map_profile", "match_sessions", "nearby_sessions", "plan_schedule", "search_sessions", "set_onsite_preferences", "status", "validate_profile"]);
    for (const entry of Object.values(registry)) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.inputSchema.type).toBe("object");
    }
  });

  it("gives callCommand the script's own output, error text included", async () => {
    const profile = { schemaVersion: 1, repos: [{ root: ".", languages: [] }], services: [{ name: "lambda", evidence: [{ repo: ".", file: "a" }] }], patterns: [] };
    const empty = createTempHome();
    try {
      const cases: Array<[CommandName, unknown, string]> = [
        ["validate_profile", { profile }, home.path],
        ["list_filters", {}, home.path],
        ["get_onsite_preferences", {}, home.path],
        ["match_sessions", { profile }, empty.path],
      ];
      // A rejected commit prints a machine-readable `reason` beside its error: stage an incomplete import, then try to commit it.
      const page = await callCommand("catalog_import", { action: "page", eventId: "reinvent2026", timezone: null, page: { items: fixture.slice(0, 3), nextToken: "t", totalCount: fixture.length } }, { storeRoot: empty.path });
      const syncId = (JSON.parse(page.text) as { syncId: string }).syncId;
      cases.push(["catalog_import", { action: "commit", syncId }, empty.path]);
      for (const [name, input, storeRoot] of cases) {
        const spawned = spawnSync(process.execPath, [bundle, name, "--json", JSON.stringify(input)], { env: { ...process.env, REINVENT_SCOUT_HOME: storeRoot }, encoding: "utf8" });
        const viaRegistry = await callCommand(name, input, { storeRoot });
        if (spawned.status === 0) {
          expect(viaRegistry.text, name).toBe(spawned.stdout.trim());
        } else {
          const printed = JSON.parse(spawned.stdout) as { error: string; reason?: string };
          expect(viaRegistry.text, name).toBe(printed.error);
          expect(viaRegistry.reason, name).toBe(printed.reason);
          if (name === "catalog_import") expect(printed.reason).toBe("incomplete");
        }
        expect(viaRegistry.isError, name).toBe(spawned.status === 1);
      }
    } finally {
      empty.cleanup();
    }
  });

  it("reports a command error as text with isError", async () => {
    const result = await callCommand("match_sessions", { profile: { not: "a profile" } }, { storeRoot: home.path });
    expect(result.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });
});
