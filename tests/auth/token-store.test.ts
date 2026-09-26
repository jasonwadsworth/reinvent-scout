import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearTokens,
  isAccessTokenExpired,
  readTokenStore,
  saveTokens,
  tokenFilePath,
  type StoredTokens,
} from "../../src/auth/token-store.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const SAMPLE: StoredTokens = {
  accessToken: "access-abc",
  refreshToken: "refresh-def",
  idToken: "id-ghi",
  tokenType: "Bearer",
  expiresIn: 3600,
  obtainedAt: 1_700_000_000_000,
};

describe("token store", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("writes tokens.json with mode 0600", () => {
    saveTokens(SAMPLE, { storeRoot: home.path });

    const stat = statSync(tokenFilePath(home.path));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates the store root at mode 0700 when it does not exist yet", () => {
    // createTempHome's own directory already exists (and mkdtempSync happens to create it at
    // 0700 anyway), which would mask a saveTokens that falls back to a bare, umask-dependent
    // mkdirSync instead of the store's hardened 0700 directory creation -- so this points at a
    // not-yet-existing child of it instead.
    const storeRoot = join(home.path, "not-created-yet");
    expect(existsSync(storeRoot)).toBe(false);

    saveTokens(SAMPLE, { storeRoot });

    expect(statSync(storeRoot).mode & 0o777).toBe(0o700);
  });

  it("round-trips access, refresh and id tokens with the obtainedAt stamp", () => {
    saveTokens(SAMPLE, { storeRoot: home.path });

    const state = readTokenStore({ storeRoot: home.path });

    expect(state).toEqual({ status: "present", tokens: SAMPLE });
  });

  it("reports no stored session when the file is absent", () => {
    const state = readTokenStore({ storeRoot: home.path });

    expect(state).toEqual({ status: "absent" });
  });

  it("reports a corrupt store rather than throwing a parse error", () => {
    mkdirSync(home.path, { recursive: true });
    writeFileSync(tokenFilePath(home.path), "{ not valid json", { mode: 0o600 });

    expect(() => readTokenStore({ storeRoot: home.path })).not.toThrow();
    const state = readTokenStore({ storeRoot: home.path });
    expect(state.status).toBe("corrupt");
  });

  it("treats the access token as expired 120 seconds before its real expiry", () => {
    const tokens: StoredTokens = { ...SAMPLE, expiresIn: 3600, obtainedAt: 0 };
    const realExpiryMs = tokens.expiresIn * 1000;

    expect(
      isAccessTokenExpired(tokens, { now: () => realExpiryMs - 121_000 }),
    ).toBe(false);
    expect(
      isAccessTokenExpired(tokens, { now: () => realExpiryMs - 120_000 }),
    ).toBe(true);
    expect(isAccessTokenExpired(tokens, { now: () => realExpiryMs })).toBe(true);
  });

  it("clears the store on logout and reports no session afterwards", () => {
    saveTokens(SAMPLE, { storeRoot: home.path });

    clearTokens({ storeRoot: home.path });

    expect(readTokenStore({ storeRoot: home.path })).toEqual({ status: "absent" });
  });

  it("does not throw when clearing a store that was never written", () => {
    expect(() => clearTokens({ storeRoot: home.path })).not.toThrow();
  });

  it("never includes token material in the string form of its errors", () => {
    mkdirSync(home.path, { recursive: true });
    const secret = "SUPER_SECRET_TOKEN_VALUE_DO_NOT_LEAK";
    // Invalid JSON that still contains what looks like real token material, to make sure a
    // naive implementation that echoes the raw content (or the native SyntaxError's message,
    // which can quote a snippet of the offending text) into an error string would be caught.
    writeFileSync(
      tokenFilePath(home.path),
      `{ "accessToken": "${secret}", this is not valid json`,
      { mode: 0o600 },
    );

    const state = readTokenStore({ storeRoot: home.path });

    expect(JSON.stringify(state)).not.toContain(secret);

    const wrongShapePath = join(home.path, "tokens.json");
    writeFileSync(wrongShapePath, JSON.stringify({ someField: secret }), { mode: 0o600 });
    const wrongShapeState = readTokenStore({ storeRoot: home.path });
    expect(JSON.stringify(wrongShapeState)).not.toContain(secret);
  });
});
