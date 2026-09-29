import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAuthCommands } from "../../src/cli/commands/auth.js";
import type { ApiClient } from "../../src/api/client.js";
import type { LoginDeps } from "../../src/auth/login.js";
import { readTokenStore, saveTokens, type StoredTokens } from "../../src/auth/token-store.js";
import { AuthRequiredError, NotRegisteredError } from "../../src/core/errors.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const NOW = 1_700_000_000_000;

const VALID_TOKENS: StoredTokens = {
  accessToken: "SUPER_SECRET_ACCESS_TOKEN_DO_NOT_LEAK",
  refreshToken: "refresh-abc",
  idToken: "id-abc",
  tokenType: "Bearer",
  expiresIn: 3600,
  obtainedAt: NOW,
};

/** Obtained a day ago with a one-hour lifetime -- expired 23 hours before `NOW`. */
const EXPIRED_TOKENS: StoredTokens = {
  ...VALID_TOKENS,
  obtainedAt: NOW - 24 * 3600 * 1000,
  expiresIn: 3600,
};

/** A minimal ApiClient stand-in -- auth status only ever calls getSchedule. */
function fakeApiClient(getSchedule: ApiClient["getSchedule"]): ApiClient {
  return {
    getSchedule,
    getSession: async () => { throw new Error("unused getSession"); },
    getEvent: async () => {
      throw new Error("not implemented in this fake");
    },
    listSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    listAllSessions: async () => {
      throw new Error("not implemented in this fake");
    },
    reserveSessions: async () => { throw new Error("unused reserveSessions"); },
    cancelReservation: async () => { throw new Error("unused cancelReservation"); },
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
}

function harness(
  storeRoot: string,
  options: {
    getSchedule?: ApiClient["getSchedule"];
    login?: (deps: LoginDeps) => Promise<void>;
  } = {},
): Harness {
  const printed: string[] = [];
  const client = fakeApiClient(
    options.getSchedule ?? (async () => ({ reserved: [], favorites: [], personalTime: [] })),
  );

  const program = new Command().exitOverride();
  registerAuthCommands(program, {
    resolveStoreRoot: () => storeRoot,
    buildApiClient: () => client,
    print: (message: string) => {
      printed.push(message);
    },
    now: () => NOW,
    ...(options.login === undefined ? {} : { login: options.login }),
  });

  return {
    run: async (args: string[]) => {
      await program.parseAsync(["node", "reinvent-scout", ...args]);
    },
    printed,
  };
}

describe("auth status command", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("reports no session when nothing is stored", async () => {
    const h = harness(home.path);

    await h.run(["auth", "status"]);

    expect(h.printed.join("\n")).toMatch(/not signed in/i);
  });

  it("exits non-zero when status finds no session", async () => {
    const h = harness(home.path);

    await h.run(["auth", "status"]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("reports the access token expiry as a relative duration and never prints the token", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const h = harness(home.path);

    await h.run(["auth", "status"]);

    const output = h.printed.join("\n");
    // Adversarial, not cosmetic: assert the actual secret value cannot appear anywhere in the
    // printed output, rather than just that the output "looks right".
    expect(output).not.toContain(VALID_TOKENS.accessToken);
    expect(output).toMatch(/expires in/i);
    // The other direction (an already-expired token) has its own distinct wording -- see the test
    // below -- so a token that hasn't expired yet must never be described that way.
    expect(output).not.toMatch(/expired/i);
  });

  it("reports an already-expired access token as expired, not as expiring, and notes it refreshes automatically", async () => {
    saveTokens(EXPIRED_TOKENS, { storeRoot: home.path });
    const h = harness(home.path);

    await h.run(["auth", "status"]);

    const output = h.printed.join("\n");
    expect(output).not.toContain(EXPIRED_TOKENS.accessToken);
    expect(output).toMatch(/expired \d+h \d+m ago; it will refresh automatically on next use\./i);
    // The other direction's wording ("expires in") must not also appear for an expired token.
    expect(output).not.toMatch(/expires in/i);
  });

  it("reports registered when GetSchedule returns 200", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const h = harness(home.path, {
      getSchedule: async () => ({ reserved: [], favorites: [], personalTime: [] }),
    });

    await h.run(["auth", "status"]);

    expect(h.printed.join("\n")).toMatch(/registered/i);
  });

  it("reports not registered for reinvent2026 and says re-login will not help when GetSchedule returns 403", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const h = harness(home.path, {
      getSchedule: async () => {
        throw new NotRegisteredError();
      },
    });

    await h.run(["auth", "status"]);

    const output = h.printed.join("\n");
    expect(output).toContain("reinvent2026");
    expect(output).toMatch(/will not help/i);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("tells the user to sign in again when the stored session is no longer valid", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const h = harness(home.path, {
      getSchedule: async () => {
        throw new AuthRequiredError();
      },
    });

    await h.run(["auth", "status"]);

    expect(h.printed.join("\n")).toMatch(/auth login/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("auth logout command", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("clears the token store on logout", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const h = harness(home.path);

    await h.run(["auth", "logout"]);

    expect(readTokenStore({ storeRoot: home.path })).toEqual({ status: "absent" });
  });

  it("does not throw when logging out with no stored session", async () => {
    const h = harness(home.path);

    await expect(h.run(["auth", "logout"])).resolves.not.toThrow();
  });
});

describe("auth login command", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("runs the login flow against the resolved store root and reports success", async () => {
    let seenStoreRoot: string | undefined;
    const h = harness(home.path, {
      login: async (deps) => {
        seenStoreRoot = deps.storeRoot;
      },
    });

    await h.run(["auth", "login"]);

    expect(seenStoreRoot).toBe(home.path);
    expect(h.printed.join("\n")).toMatch(/signed in/i);
  });

  it("propagates a login failure with a clear message rather than a raw stack trace", async () => {
    const h = harness(home.path, {
      login: async () => {
        throw new Error("state mismatch");
      },
    });

    await expect(h.run(["auth", "login"])).rejects.toThrow("state mismatch");
  });
});
