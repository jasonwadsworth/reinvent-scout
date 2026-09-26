import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCatalogCommands } from "../../src/cli/commands/catalog.js";
import type { ApiClient, ListAllSessionsOptions, ListAllSessionsResult } from "../../src/api/client.js";
import { AuthRequiredError, NotRegisteredError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

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
