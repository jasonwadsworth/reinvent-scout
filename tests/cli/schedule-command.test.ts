import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client.js";
import type { BulkResult, Schedule, Session } from "../../src/api/types.js";
import { buildIndexRecord } from "../../src/catalog/index-record.js";
import { CURRENT_SCHEMA_VERSION, writeCatalog, type CatalogMeta } from "../../src/catalog/store.js";
import { DEFAULT_EVENT_ID } from "../../src/catalog/sync.js";
import { registerScheduleCommands } from "../../src/cli/commands/schedule.js";
import { NotFoundError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture: Session[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "catalog-sample.json"), "utf8"),
);
const ANT301 = fixture.find((session) => session.abbreviation === "ANT301")!;

function sampleMeta(overrides: Partial<CatalogMeta> = {}): CatalogMeta {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: DEFAULT_EVENT_ID,
    syncedAt: 1_700_000_000_000,
    totalCount: fixture.length,
    count: fixture.length,
    includedAbstracts: true,
    ...overrides,
  };
}

function seedFixtureCatalog(storeRoot: string): void {
  writeCatalog(
    { raw: fixture, index: fixture.map(buildIndexRecord), meta: sampleMeta() },
    { storeRoot },
  );
}

interface ApiClientOverrides {
  getSchedule?: ApiClient["getSchedule"];
  associateFavorites?: ApiClient["associateFavorites"];
  disassociateFavorite?: ApiClient["disassociateFavorite"];
}

function fakeApiClient(overrides: ApiClientOverrides = {}): ApiClient {
  return {
    getSchedule: overrides.getSchedule ?? (async (): Promise<Schedule> => ({
      reserved: [],
      favorites: [],
      personalTime: [],
    })),
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    associateFavorites:
      overrides.associateFavorites ??
      (async (): Promise<BulkResult> => {
        throw new Error("not implemented in this fake");
      }),
    disassociateFavorite:
      overrides.disassociateFavorite ??
      (async () => {
        throw new Error("not implemented in this fake");
      }),
  };
}

interface Harness {
  run: (args: string[]) => Promise<void>;
  printed: string[];
  client: ApiClient;
}

function harness(storeRoot: string, overrides: ApiClientOverrides = {}): Harness {
  const printed: string[] = [];
  const client = fakeApiClient(overrides);
  const program = new Command().exitOverride();
  registerScheduleCommands(program, {
    resolveStoreRoot: () => storeRoot,
    buildApiClient: () => client,
    print: (message: string) => {
      printed.push(message);
    },
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
    client,
  };
}

/**
 * Substitutes `process.stdin` with a real `PassThrough` stream for the duration of `fn`, so a
 * command's own real stdin-reading code (an async iteration over `process.stdin`, not an injected
 * "give me a string" callback a test could trivially fake) is what's actually exercised -- the
 * same mechanism a real `match --json | jq ... | reinvent-scout schedule favorite -` pipe drives.
 * `process.stdin`'s own property descriptor is configurable, which is what makes this substitution
 * possible at all; restored unconditionally afterward.
 */
async function withPipedStdin<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const fake = new PassThrough();
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    fake.end(text);
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", original);
  }
}

describe("schedule show", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("prints the schedule grouped by day with times and venues", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      getSchedule: async () => ({ reserved: [ANT301.sessionId], favorites: [], personalTime: [] }),
    });

    await h.run(["schedule", "show"]);

    const output = h.printed.join("\n");
    expect(output).toContain(ANT301.sessionTime!.date!);
    expect(output).toContain(ANT301.sessionTime!.time!);
    expect(output).toContain(ANT301.venue!);
  });

  it("prints compact JSON under --json", async () => {
    seedFixtureCatalog(home.path);
    const h = harness(home.path, {
      getSchedule: async () => ({ reserved: [ANT301.sessionId], favorites: [], personalTime: [] }),
    });

    await h.run(["schedule", "show", "--json"]);

    expect(h.printed).toHaveLength(1);
    const parsed = JSON.parse(h.printed[0]!);
    expect(parsed.reserved).toHaveLength(1);
    expect(parsed.reserved[0].sessionId).toBe(ANT301.sessionId);
    expect(parsed.reserved[0].resolved).toBe(true);
  });
});

describe("schedule favorite", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("favorites the ids given on the command line and prints what succeeded and what was refused", async () => {
    const h = harness(home.path, {
      associateFavorites: async () => ({
        successful: ["a"],
        failed: [{ sessionId: "b", code: "scheduleConflict", conflictsWith: ["c"] }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: ["a"], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", "a", "b"]);

    const output = h.printed.join("\n");
    expect(output).toContain("a");
    expect(output).toContain("b");
    expect(output).toMatch(/scheduleConflict/);
  });

  it("exits non-zero when any session was refused, in a response that also has a real success", async () => {
    // The mixed case is the one that actually distinguishes "checks the response" from "assumes
    // success" -- an all-refused response would pass under either exit-code implementation.
    const h = harness(home.path, {
      associateFavorites: async () => ({
        successful: ["a"],
        failed: [{ sessionId: "b", code: "sessionFull" }],
      }),
      getSchedule: async () => ({ reserved: [], favorites: ["a"], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", "a", "b"]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("exits zero when everything succeeded", async () => {
    const h = harness(home.path, {
      associateFavorites: async (_eventId, sessionIds) => ({ successful: sessionIds, failed: [] }),
      getSchedule: async () => ({ reserved: [], favorites: ["a", "b"], personalTime: [] }),
    });

    await h.run(["schedule", "favorite", "a", "b"]);

    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reads ids from stdin when given a dash, so match output can be piped in", async () => {
    let receivedIds: string[] | undefined;
    const h = harness(home.path, {
      associateFavorites: async (_eventId, sessionIds) => {
        receivedIds = [...sessionIds];
        return { successful: sessionIds, failed: [] };
      },
      getSchedule: async () => ({ reserved: [], favorites: ["id-1", "id-2", "id-3"], personalTime: [] }),
    });

    await withPipedStdin("id-1\nid-2\n\nid-3\n", async () => {
      await h.run(["schedule", "favorite", "-"]);
    });

    expect(receivedIds).toEqual(["id-1", "id-2", "id-3"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("refuses more than one hundred ids in one invocation", async () => {
    let called = false;
    const h = harness(home.path, {
      associateFavorites: async (_eventId, sessionIds) => {
        called = true;
        return { successful: sessionIds, failed: [] };
      },
    });
    const tooManyIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);

    await h.run(["schedule", "favorite", ...tooManyIds]);

    expect(called).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(h.printed.join("\n")).toMatch(/100/);
  });
});

describe("schedule unfavorite", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("removes a favorite and reports success", async () => {
    let called: { eventId: string; sessionId: string } | undefined;
    const h = harness(home.path, {
      disassociateFavorite: async (eventId, sessionId) => {
        called = { eventId, sessionId };
      },
    });

    await h.run(["schedule", "unfavorite", "s1"]);

    expect(called).toEqual({ eventId: DEFAULT_EVENT_ID, sessionId: "s1" });
    expect(h.printed.join("\n")).toContain("s1");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports that a session was not favorited, without treating it as an error", async () => {
    const h = harness(home.path, {
      disassociateFavorite: async () => {
        throw new NotFoundError("No favorite with that session id.");
      },
    });

    await h.run(["schedule", "unfavorite", "s1"]);

    expect(h.printed.join("\n")).toMatch(/not favorited/i);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
