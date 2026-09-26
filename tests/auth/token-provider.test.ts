import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthRequiredError } from "../../src/core/errors.js";
import { getAccessToken } from "../../src/auth/token-provider.js";
import { readTokenStore, saveTokens, type StoredTokens } from "../../src/auth/token-store.js";
import { OAuthError } from "../../src/auth/oauth.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const VALID_TOKENS: StoredTokens = {
  accessToken: "valid-access",
  refreshToken: "refresh-abc",
  idToken: "id-abc",
  tokenType: "Bearer",
  expiresIn: 3600,
  obtainedAt: 0,
};

// obtainedAt 0, expiresIn 100 -> real expiry at 100_000ms; "now" below sits inside the 120s skew
// window, so a caller reading it at that instant must trigger a refresh.
const EXPIRING_SOON_TOKENS: StoredTokens = {
  ...VALID_TOKENS,
  accessToken: "expiring-access",
  expiresIn: 100,
};

describe("getAccessToken", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("returns the stored access token while it is still valid", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const fake = createFakeFetch([]);

    const token = await getAccessToken({
      storeRoot: home.path,
      now: () => 1000,
      fetchFn: fake.fetch,
    });

    expect(token).toBe("valid-access");
    expect(fake.calls).toHaveLength(0);
  });

  it("refreshes once and persists the new token when the stored one is inside the skew window", async () => {
    saveTokens(EXPIRING_SOON_TOKENS, { storeRoot: home.path });
    const fake = createFakeFetch([
      {
        status: 200,
        json: {
          access_token: "refreshed-access",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const token = await getAccessToken({
      storeRoot: home.path,
      // 100_000ms real expiry minus the 120_000ms skew is already negative, so any "now" is
      // inside the window; pick something concrete and unambiguous.
      now: () => 50_000,
      fetchFn: fake.fetch,
    });

    expect(token).toBe("refreshed-access");
    expect(fake.calls).toHaveLength(1);

    const state = readTokenStore({ storeRoot: home.path });
    expect(state).toEqual({
      status: "present",
      tokens: {
        accessToken: "refreshed-access",
        // Provider omitted both on the refresh grant; the existing ones must be kept, not lost.
        refreshToken: EXPIRING_SOON_TOKENS.refreshToken,
        idToken: EXPIRING_SOON_TOKENS.idToken,
        tokenType: "Bearer",
        expiresIn: 3600,
        obtainedAt: 50_000,
      },
    });
  });

  it("does not call the token endpoint twice for two concurrent callers", async () => {
    saveTokens(EXPIRING_SOON_TOKENS, { storeRoot: home.path });
    const fake = createFakeFetch([
      { status: 200, json: { access_token: "refreshed-access", token_type: "Bearer", expires_in: 3600 } },
    ]);

    const deps = { storeRoot: home.path, now: () => 50_000, fetchFn: fake.fetch };
    const [first, second] = await Promise.all([getAccessToken(deps), getAccessToken(deps)]);

    expect(first).toBe("refreshed-access");
    expect(second).toBe("refreshed-access");
    // fake-fetch repeats its last queued response forever, so a broken single-flight (two
    // independent refreshes) would still resolve both callers to the same value and pass a
    // weaker assertion -- the call count is the only thing that actually proves single-flight.
    expect(fake.calls).toHaveLength(1);
  });

  it("throws AuthRequiredError and clears the store when the refresh is rejected with invalid_grant", async () => {
    saveTokens(EXPIRING_SOON_TOKENS, { storeRoot: home.path });
    const fake = createFakeFetch([
      {
        status: 400,
        json: { error: "invalid_grant", error_description: "Refresh Token has been revoked" },
      },
    ]);

    await expect(
      getAccessToken({ storeRoot: home.path, now: () => 50_000, fetchFn: fake.fetch }),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    expect(readTokenStore({ storeRoot: home.path })).toEqual({ status: "absent" });
  });

  it("propagates a transient refresh failure without clearing the store", async () => {
    saveTokens(EXPIRING_SOON_TOKENS, { storeRoot: home.path });
    const fake = createFakeFetch([{ status: 500, json: { error: "server_error" } }]);

    await expect(
      getAccessToken({ storeRoot: home.path, now: () => 50_000, fetchFn: fake.fetch }),
    ).rejects.toBeInstanceOf(OAuthError);

    expect(readTokenStore({ storeRoot: home.path })).toEqual({
      status: "present",
      tokens: EXPIRING_SOON_TOKENS,
    });
  });

  it("throws AuthRequiredError when no session is stored", async () => {
    const fake = createFakeFetch([]);

    await expect(
      getAccessToken({ storeRoot: home.path, now: () => 0, fetchFn: fake.fetch }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fake.calls).toHaveLength(0);
  });
});
