import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCatalogCommands } from "../../src/cli/commands/catalog.js";
import { registerScheduleCommands } from "../../src/cli/commands/schedule.js";
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
    // syncCatalog (the real one, not a fake -- see the comment above) calls this for real on
    // every full sync, so unlike the other unused methods it must return a value rather than
    // throw. No timezone: these tests only prove the command's own wiring, not timezone handling.
    getEvent: async (eventId) => ({ eventId }),
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions,
    associateFavorites: async () => {
      throw new Error("not implemented in this fake");
    },
    disassociateFavorite: async () => {
      throw new Error("not implemented in this fake");
    },
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
          timezone: null,
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

  it("prints each abstract under its result line when --include-abstracts is given without --json", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "graviton", "--include-abstracts", "--limit", "3"]);

    const text = h.printed.join("\n");
    // ANT301 is a fixture session that definitely carries an abstract; its text must appear,
    // not just the one-line summary the flag-less form prints.
    expect(text).toContain("ANT301");
    // This phrase occurs only in ANT301's abstract, never in any fixture title, so a summary
    // line alone cannot satisfy it.
    expect(text).toContain("accessible to everyone on your team");
  });

  it("does not print abstracts in human-readable output without the flag", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "graviton", "--limit", "3"]);

    const text = h.printed.join("\n");
    expect(text).toContain("ANT301");
    expect(text).not.toContain("accessible to everyone on your team");
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

  it("prints a human-readable message when nothing matches, but an empty json array under --json", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "zzznomatchzzz"]);

    expect(h.printed).toEqual(["No sessions matched."]);

    const jsonHarness = localHarness(home.path);
    await jsonHarness.run(["catalog", "search", "zzznomatchzzz", "--json"]);

    expect(jsonHarness.printed).toEqual(["[]"]);
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
          timezone: null,
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

  it("resolves a base code (a repeat suffix stripped) to its earliest sitting, listing the others as JSON", async () => {
    // API303-R/API303-R1 are the fixture's real repeat pair (see tests/fixtures/README.md); there
    // is no bare "API303" abbreviation, so this can only resolve through the base-code fallback --
    // exactly what a reader would type after `match` printed "API303" as a candidate's code.
    const h = localHarness(home.path);

    await h.run(["catalog", "show", "API303", "--json"]);

    expect(h.printed).toHaveLength(1);
    const result = JSON.parse(h.printed[0]!) as Record<string, unknown>;
    expect(result.abbreviation).toBe("API303-R");
    expect(result.relatedAbbreviations).toEqual(["API303-R1"]);
  });

  it("prints one line per sitting, in time order, each naming its abbreviation, session id, day, time and venue/room", async () => {
    // Lead's decision: a session id is otherwise never in any human-readable output at all (only
    // --json carries it), which left a reader with nothing real to paste into `schedule favorite`.
    // API303-R sits 2026-11-30 14:30, API303-R1 sits 2026-12-02 10:30 (see
    // tests/fixtures/README.md) -- the earlier one must print first regardless of which token
    // resolved the lookup.
    const h = localHarness(home.path);

    await h.run(["catalog", "show", "API303"]);

    const text = h.printed.join("\n");
    const firstIndex = text.indexOf("API303-R --");
    const secondIndex = text.indexOf("API303-R1 --");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(text).toContain("API303-R -- 1780441491675001GHkU -- 2026-11-30 -- 14:30 -- Caesars Forum");
    expect(text).toContain(
      "API303-R1 -- 1780441491675002GHkV -- 2026-12-02 -- 10:30 -- Caesars Forum",
    );
    // No more special-cased "Also offered as" line -- the per-sitting list replaces it entirely.
    expect(text).not.toContain("Also offered as");
  });

  it("keeps sittings in time order even when the token names the later sitting's own abbreviation directly", async () => {
    // The trap a naive `[record, ...relatedRecords]` (no re-sort) falls into: looking up "API303"
    // (the base code) happens to resolve `record` to the *earliest* sitting already, by
    // construction, so that case alone can't tell a real re-sort apart from one that was silently
    // dropped -- confirmed directly: removing the `.sort(compareByStartDateTime)` call left the
    // "API303" test above still green. Looking up "API303-R1" (the *later* sitting's own
    // abbreviation) directly makes `record` the later one and `relatedRecords` the earlier one, so
    // only a real re-sort puts API303-R back in front.
    const h = localHarness(home.path);

    await h.run(["catalog", "show", "API303-R1"]);

    const text = h.printed.join("\n");
    const firstIndex = text.indexOf("API303-R --");
    const secondIndex = text.indexOf("API303-R1 --");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("still prints its one sitting's own detail line for a session with no repeats", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "show", "ANT301"]);

    const text = h.printed.join("\n");
    expect(text).toContain("ANT301 -- 1780441461150001GGoc -- 2026-11-30 -- 10:30 -- MGM Grand");
    expect(text).not.toContain("Also offered as");
  });

  it("prints a session id in human-readable output that schedule favorite accepts", async () => {
    // Lead's own regression test: the whole point of listing each sitting's session id is that a
    // reader now has something real to paste. Parses the id out of catalog show's own printed text
    // (not --json -- the human path is what's being proven here) and feeds it straight into
    // `schedule favorite` against a fake API, asserting the fake actually received it.
    const catalogShow = localHarness(home.path);
    await catalogShow.run(["catalog", "show", "ANT301"]);
    const line = catalogShow.printed.join("\n").split("\n").find((l) => l.includes(" -- "))!;
    const sessionId = line.trim().split(" -- ")[1]!;
    expect(sessionId).toBe("1780441461150001GGoc");

    const associateFavoritesCalls: string[][] = [];
    const scheduleProgram = new Command().exitOverride();
    registerScheduleCommands(scheduleProgram, {
      resolveStoreRoot: () => home.path,
      buildApiClient: () => ({
        getSchedule: async () => ({ reserved: [], favorites: [sessionId], personalTime: [] }),
        getEvent: async () => {
          throw new Error("not implemented in this fake");
        },
        listSessions: async () => {
          throw new Error("not implemented in this fake");
        },
        listAllSessions: async () => {
          throw new Error("not implemented in this fake");
        },
        associateFavorites: async (_eventId: string, sessionIds: string[]) => {
          associateFavoritesCalls.push(sessionIds);
          return { successful: sessionIds, failed: [] };
        },
        disassociateFavorite: async () => {
          throw new Error("not implemented in this fake");
        },
      }),
      print: () => {},
    });

    await scheduleProgram.parseAsync(["node", "reinvent-scout", "schedule", "favorite", sessionId]);

    expect(associateFavoritesCalls).toEqual([[sessionId]]);
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

  it("shows a session using the abbreviation exactly as search printed it, not a hardcoded id", async () => {
    // Deliberately does not take ANT301 from the fixture directly: search prints only the
    // abbreviation (real session ids are opaque, e.g. "1780441461150001GGoc"), so that's the
    // only thing a user actually has to paste back in. Parsing it out of search's own output,
    // rather than assuming what it prints, is precisely how this defect got past review the
    // first time.
    const searchHarness = localHarness(home.path);
    await searchHarness.run(["catalog", "search", "graviton"]);
    const searchLine = searchHarness.printed
      .join("\n")
      .split("\n")
      .find((line) => line.includes("Graviton"));
    expect(searchLine).toBeDefined();
    const token = searchLine!.split(" ")[0]!;

    const showHarness = localHarness(home.path);
    await showHarness.run(["catalog", "show", token]);

    expect(showHarness.printed.join("\n")).toContain("Graviton");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("resolves an abbreviation case-insensitively", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "show", "ant301"]);

    expect(h.printed.join("\n")).toContain("Graviton");
  });

  it("lists every candidate and exits non-zero when an abbreviation matches more than one session", async () => {
    // Nothing in the API guarantees abbreviation uniqueness across events (only checked true for
    // the real 2,043-session catalog) -- this must never silently pick one.
    const ambiguousHome = createTempHome();
    try {
      const dupA: Session = { sessionId: "dup-session-a", abbreviation: "DUP100", title: "First" };
      const dupB: Session = { sessionId: "dup-session-b", abbreviation: "DUP100", title: "Second" };
      writeCatalog(
        {
          raw: [dupA, dupB],
          index: [dupA, dupB].map(buildIndexRecord),
          meta: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            eventId: "reinvent2026",
            syncedAt: 1_700_000_000_000,
            totalCount: 2,
            count: 2,
            includedAbstracts: true,
            timezone: null,
          },
        },
        { storeRoot: ambiguousHome.path },
      );
      const h = localHarness(ambiguousHome.path);

      await h.run(["catalog", "show", "DUP100"]);

      const output = h.printed.join("\n");
      expect(output).toContain("dup-session-a");
      expect(output).toContain("dup-session-b");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    } finally {
      ambiguousHome.cleanup();
    }
  });
});

describe("catalog search and show against an unusable index", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
    // An index written by an older version of this tool: same data, older schema version. The
    // read path must refuse it with the rebuild remedy rather than serving possibly-poisoned terms.
    writeCatalog(
      {
        raw: fixture,
        index: fixture.map(buildIndexRecord),
        meta: {
          schemaVersion: CURRENT_SCHEMA_VERSION - 1,
          eventId: "reinvent2026",
          syncedAt: 1_700_000_000_000,
          totalCount: fixture.length,
          count: fixture.length,
          includedAbstracts: true,
          timezone: null,
        },
      },
      { storeRoot: home.path },
    );
  });

  afterEach(() => {
    process.exitCode = 0;
    home.cleanup();
  });

  it("search tells the user to rebuild the index and exits non-zero instead of throwing", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "search", "graviton"]);

    expect(h.printed.join("\n")).toContain("catalog sync");
    expect(h.printed.join("\n")).toMatch(/older format|rebuilt/);
    expect(process.exitCode).toBe(1);
  });

  it("show tells the user to rebuild the index and exits non-zero instead of throwing", async () => {
    const h = localHarness(home.path);

    await h.run(["catalog", "show", "ANT301"]);

    expect(h.printed.join("\n")).toContain("catalog sync");
    expect(process.exitCode).toBe(1);
  });
});
