import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenProviderAdapter } from "../../src/auth/provider-adapter.js";
import { saveTokens, type StoredTokens } from "../../src/auth/token-store.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

/**
 * The API client depends on `GetAccessTokenOptions` -- the provider's own exported per-call
 * options type -- so this adapter is the one place production code binds the provider's fixed
 * deps (store root, fetch, clock) into the shape the client expects. Testing it directly, rather
 * than only through the cross-module integration test, pins its two responsibilities: passing
 * options through untouched and using the bound deps for everything else.
 */

const VALID_TOKENS: StoredTokens = {
  accessToken: "valid-access",
  refreshToken: "refresh-abc",
  idToken: "id-abc",
  tokenType: "Bearer",
  expiresIn: 3600,
  obtainedAt: 0,
};

describe("createTokenProviderAdapter", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("returns the stored token with no options, using the bound deps", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const fake = createFakeFetch([]);
    const getAccessToken = createTokenProviderAdapter({
      storeRoot: home.path,
      now: () => 1000,
      fetchFn: fake.fetch,
    });

    const token = await getAccessToken();

    expect(token).toBe("valid-access");
    expect(fake.calls).toHaveLength(0);
  });

  it("forwards forceRefresh to the bound provider", async () => {
    saveTokens(VALID_TOKENS, { storeRoot: home.path });
    const fake = createFakeFetch([
      { status: 200, json: { access_token: "forced-access", token_type: "Bearer", expires_in: 3600 } },
    ]);
    const getAccessToken = createTokenProviderAdapter({
      storeRoot: home.path,
      now: () => 1000,
      fetchFn: fake.fetch,
    });

    const token = await getAccessToken({ forceRefresh: true });

    expect(token).toBe("forced-access");
    expect(fake.calls).toHaveLength(1);
  });
});
