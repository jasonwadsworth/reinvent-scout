import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCatalogCommands } from "../../src/cli/commands/catalog.js";
import type { ApiClient, ListAllSessionsOptions, ListAllSessionsResult } from "../../src/api/client.js";
import type { Session } from "../../src/api/types.js";
import { AuthRequiredError, NotRegisteredError } from "../../src/core/errors.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog } from "../../src/catalog/store.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);

/** A minimal ApiClient stand-in, same shape as the one in tests/catalog/sync.test.ts -- the CLI
 * layer's own tests only need to prove the command wires flags into syncCatalog and formats its
 * result correctly, not re-prove sync's own logic. */
function fakeApiClient(
  listAllSessions: (eventId: string, options?: ListAllSessionsOptions) => Promise<ListAllSessionsResult>,
): ApiClient {
  return {
    getSchedule: async () => {
      throw new Error("not implemented in this fake");
    },
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions,
  };
}

interface Harness {
  run: (args: string[]) => Promise<void>;
  printed: string[];
  seenEventId: string | undefined;
  seenOptions: ListAllSessionsOptions | undefined;
}

function harness(
  storeRoot: string,
  listAllSessions: (eventId: string, options?: ListAllSessionsOptions) => Promise<ListAllSessionsResult>,
): Harness {
  const printed: string[] = [];
  let seenEventId: string | undefined;
  let seenOptions: ListAllSessionsOptions | undefined;

  const client = fakeApiClient(async (eventId, options) => {
    seenEventId = eventId;
    seenOptions = options;
    return listAllSessions(eventId, options);
  });

  const program = new Command().exitOverride();
  registerCatalogCommands(program, {
    resolveStoreRoot: () => storeRoot,
    buildApiClient: () => client,
    print: (message: string) => {
      printed.push(message);
    },
    now: () => 1_700_000_000_000,
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
    get seenEventId() {
      return seenEventId;
    },
    get seenOptions() {
      return seenOptions;
    },
  };
}

describe("catalog sync command", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("runs catalog sync and prints a human-readable summary", async () => {
    const h = harness(home.path, async () => ({
      sessions: [{ sessionId: "s1", title: "A session" }],
      totalCount: 1,
    }));

    await h.run(["catalog", "sync"]);

    expect(h.printed.join("\n")).toContain("1 session");
  });

  it("prints compact JSON under --json", async () => {
    const h = harness(home.path, async () => ({
      sessions: [{ sessionId: "s1", title: "A session" }],
      totalCount: 1,
    }));

    await h.run(["catalog", "sync", "--json"]);

    expect(h.printed).toHaveLength(1);
    const parsed = JSON.parse(h.printed[0]!) as { count: number; totalCount: number };
    expect(parsed.count).toBe(1);
    expect(parsed.totalCount).toBe(1);
  });

  it("defaults the event to reinvent2026", async () => {
    const h = harness(home.path, async () => ({ sessions: [], totalCount: 0 }));

    await h.run(["catalog", "sync"]);

    expect(h.seenEventId).toBe("reinvent2026");
  });

  it("uses the --event flag when given", async () => {
    const h = harness(home.path, async () => ({ sessions: [], totalCount: 0 }));

    await h.run(["catalog", "sync", "--event", "reinvent2027-summit"]);

    expect(h.seenEventId).toBe("reinvent2027-summit");
  });

  it("excludes abstracts under --no-abstracts", async () => {
    const h = harness(home.path, async () => ({ sessions: [], totalCount: 0 }));

    await h.run(["catalog", "sync", "--no-abstracts"]);

    expect(h.seenOptions?.includeAbstracts).toBe(false);
  });

  it("includes abstracts by default", async () => {
    const h = harness(home.path, async () => ({ sessions: [], totalCount: 0 }));

    await h.run(["catalog", "sync"]);

    expect(h.seenOptions?.includeAbstracts).toBe(true);
  });

  it("warns distinctly when the server never reported a totalCount at all", async () => {
    const h = harness(home.path, async () => ({
      sessions: [{ sessionId: "s1", title: "A session" }],
      // Simulates the response omitting totalCount entirely -- countMismatch alone would stay
      // false here (nothing to compare against), so this must not be silent.
      totalCount: undefined as unknown as number,
    }));

    await h.run(["catalog", "sync"]);

    expect(h.printed.join("\n").toLowerCase()).toContain("did not report");
  });

  it("prints a mismatch warning when the stored count does not match the reported totalCount", async () => {
    const h = harness(home.path, async () => ({
      sessions: [{ sessionId: "s1", title: "A session" }],
      totalCount: 5,
    }));

    await h.run(["catalog", "sync"]);

    expect(h.printed.join("\n")).toMatch(/5/);
  });

  it("tells the user to run auth login when there is no session, and exits non-zero", async () => {
    const h = harness(home.path, async () => {
      throw new AuthRequiredError();
    });

    await h.run(["catalog", "sync"]);

    expect(h.printed.join("\n")).toContain("auth login");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("tells the user they are not registered for the event, and exits non-zero", async () => {
    const h = harness(home.path, async () => {
      throw new NotRegisteredError();
    });

    await h.run(["catalog", "sync"]);

    expect(h.printed.join("\n")).toContain("not registered");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/** Search and show are pure local reads -- no ApiClient involved at all, so this harness is
 * simpler than catalog sync's: seed a real catalog under a real temp store root, run the
 * command, and read back what was printed. */
function localHarness(storeRoot: string): { run: (args: string[]) => Promise<void>; printed: string[] } {
  const printed: string[] = [];
  const program = new Command().exitOverride();
  registerCatalogCommands(program, {
    resolveStoreRoot: () => storeRoot,
    print: (message: string) => {
      printed.push(message);
    },
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
  };
}

describe("catalog search command", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
    writeCatalog(
      {
        raw: fixture,
        index: fixture.map(buildIndexRecord),
        meta: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          eventId: "reinvent2026",
          syncedAt: 1_700_000_000_000,
          totalCount: fixture.length,
          count: fixture.length,
          includedAbstracts: true,
        },
      },
      { storeRoot: home.path },
    );
  });

  afterEach(() => {
    home.cleanup();
  });

  it("prints compact JSON with no abstracts under --json", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "graviton", "--json"]);

    expect(h.printed).toHaveLength(1);
    const results = JSON.parse(h.printed[0]!) as Array<Record<string, unknown>>;
    expect(results.some((r) => r.abbreviation === "ANT301")).toBe(true);
    for (const result of results) {
      expect(result).not.toHaveProperty("abstract");
      // The internal term-frequency maps are never agent/user-facing output.
      expect(result).not.toHaveProperty("titleTerms");
      expect(result).not.toHaveProperty("bodyTerms");
    }
  });

  it("includes abstracts only when --include-abstracts is passed", async () => {
    const withoutFlag = localHarness(home.path);
    await withoutFlag.run(["catalog", "search", "graviton", "--json"]);
    const withoutResults = JSON.parse(withoutFlag.printed[0]!) as Array<Record<string, unknown>>;
    const ant301Without = withoutResults.find((r) => r.abbreviation === "ANT301");
    expect(ant301Without).not.toHaveProperty("abstract");

    const withFlag = localHarness(home.path);
    await withFlag.run(["catalog", "search", "graviton", "--json", "--include-abstracts"]);
    const withResults = JSON.parse(withFlag.printed[0]!) as Array<Record<string, unknown>>;
    const ant301With = withResults.find((r) => r.abbreviation === "ANT301");
    expect(ant301With?.abstract).toBe(
      fixture.find((s) => s.abbreviation === "ANT301")!.abstract,
    );
  });

  it("filters by --type", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "--type", "Chalk talk", "--json"]);

    const results = JSON.parse(h.printed[0]!) as Array<Record<string, unknown>>;
    expect(results.map((r) => r.abbreviation).sort()).toEqual(["IND391", "INV501"]);
  });

  it("caps results at --limit", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "--type", "Breakout session", "--limit", "3", "--json"]);

    const results = JSON.parse(h.printed[0]!) as unknown[];
    expect(results).toHaveLength(3);
  });

  it("prints a human-readable list without --json", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "graviton"]);

    expect(h.printed.join("\n")).toContain("ANT301");
  });

  it("tells the user to sync first when nothing has been synced", async () => {
    const emptyHome = createTempHome();
    try {
      const h = localHarness(emptyHome.path);

      await h.run(["catalog", "search", "graviton"]);

      expect(h.printed.join("\n")).toContain("catalog sync");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    } finally {
      emptyHome.cleanup();
    }
  });
});

describe("catalog show command", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
    writeCatalog(
      {
        raw: fixture,
        index: fixture.map(buildIndexRecord),
        meta: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          eventId: "reinvent2026",
          syncedAt: 1_700_000_000_000,
          totalCount: fixture.length,
          count: fixture.length,
          includedAbstracts: true,
        },
      },
      { storeRoot: home.path },
    );
  });

  afterEach(() => {
    home.cleanup();
  });

  it("shows a session as JSON including its abstract", async () => {
    const h = localHarness(home.path);
    const session = fixture.find((s) => s.abbreviation === "ANT301")!;

    await h.run(["catalog", "show", session.sessionId, "--json"]);

    expect(h.printed).toHaveLength(1);
    const result = JSON.parse(h.printed[0]!) as Record<string, unknown>;
    expect(result.abbreviation).toBe("ANT301");
    expect(result.abstract).toBe(session.abstract);
    expect(result).not.toHaveProperty("titleTerms");
    expect(result).not.toHaveProperty("bodyTerms");
  });

  it("reports a friendly message when the session id is not found", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "show", "does-not-exist"]);

    expect(h.printed.join("\n")).toMatch(/no session/i);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("tells the user to sync first when nothing has been synced", async () => {
    const emptyHome = createTempHome();
    try {
      const h = localHarness(emptyHome.path);

      await h.run(["catalog", "show", "any-id"]);

      expect(h.printed.join("\n")).toContain("catalog sync");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    } finally {
      emptyHome.cleanup();
    }
  });
});
