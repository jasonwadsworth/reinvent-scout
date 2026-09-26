import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { createTokenProviderAdapter } from "../../src/auth/provider-adapter.js";
import { TOKEN_URL } from "../../src/auth/oauth.js";
import { readTokenStore, saveTokens, type StoredTokens } from "../../src/auth/token-store.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

/**
 * Cross-module test: the real API client against the real token provider.
 *
 * Every other test of the 401 retry injects a fake `getAccessToken` that honours
 * `{ forceRefresh: true }`. That proves the client asks for a fresh token; it does not prove
 * anything can give it one. This test wires the client to the provider the CLI will actually
 * use, so the contract is exercised end to end rather than against a fake that implements it.
 *
 * The scenario is the one the retry exists for: the server rejects an access token the provider
 * still believes is valid (revoked server-side, rotated signing key, clock skew). The stored
 * token is nowhere near its expiry, so a provider that only refreshes on expiry hands back the
 * same rejected token and the retry achieves nothing.
 */

const EVENT_ID = "reinvent2026";
const API_BASE_URL = "https://api.awsevents.com";
const NOW = 1_700_000_000_000;

const STORED: StoredTokens = {
  accessToken: "stored-access-token",
  refreshToken: "stored-refresh-token",
  idToken: "stored-id-token",
  tokenType: "Bearer",
  // Obtained "now" with an hour to run, so it is far outside the 120-second skew window and
  // `isAccessTokenExpired` reports false.
  expiresIn: 3600,
  obtainedAt: NOW,
};

const REFRESHED_ACCESS_TOKEN = "refreshed-access-token";
const SCHEDULE_BODY = { schedule: { reserved: [], favorites: [], personalTime: [] } };

interface RecordedRequest {
  url: string;
  authorization: string | null;
}

interface RoutingFetch {
  fetchFn: typeof fetch;
  apiRequests: RecordedRequest[];
  tokenRequests: RecordedRequest[];
}

/**
 * One fake `fetch` shared by the client and the provider, routed by URL: the OAuth token
 * endpoint answers a refresh, and the API endpoint rejects the first request and accepts the
 * second. Nothing here touches the network.
 */
function createRoutingFetch(): RoutingFetch {
  const apiRequests: RecordedRequest[] = [];
  const tokenRequests: RecordedRequest[] = [];

  const respond = (status: number, body: unknown): Response =>
    ({
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const authorization = new Headers(init?.headers).get("Authorization");

    if (url.startsWith(TOKEN_URL)) {
      tokenRequests.push({ url, authorization });
      // A real refresh_token grant against this provider returns no refresh_token: the existing
      // one stays valid.
      return respond(200, {
        access_token: REFRESHED_ACCESS_TOKEN,
        id_token: "refreshed-id-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    apiRequests.push({ url, authorization });
    // Models a token revoked server-side: the stored credential is rejected however many times
    // it is presented, and only a genuinely refreshed one is accepted. A fake that accepted the
    // second request regardless of its token would pass even when the retry re-sent the
    // rejected credential, which is the bug this test exists to catch.
    if (authorization === `Bearer ${REFRESHED_ACCESS_TOKEN}`) {
      return respond(200, SCHEDULE_BODY);
    }
    return respond(401, { message: "The access token is not valid." });
  }) as unknown as typeof fetch;

  return { fetchFn, apiRequests, tokenRequests };
}

describe("api client wired to the real token provider", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("forces a real refresh and retries with the new token when the server rejects a token the provider believed valid", async () => {
    saveTokens(STORED, { storeRoot: home.path });
    const routing = createRoutingFetch();

    // The wiring the CLI needs: the client's optional forceRefresh flag forwarded into the real
    // token provider, through the same production adapter `auth login`/the CLI commands use --
    // not a test-local stand-in.
    const getAccessTokenForClient = createTokenProviderAdapter({
      storeRoot: home.path,
      fetchFn: routing.fetchFn,
      now: () => NOW,
    });

    const client = createApiClient({
      fetchFn: routing.fetchFn,
      baseUrl: API_BASE_URL,
      getAccessToken: getAccessTokenForClient,
    });

    const schedule = await client.getSchedule(EVENT_ID);

    expect(schedule).toEqual(SCHEDULE_BODY.schedule);

    // The first request carries the stored token; the 401 must then drive a real refresh.
    expect(routing.apiRequests).toHaveLength(2);
    expect(routing.apiRequests[0]?.authorization).toBe(`Bearer ${STORED.accessToken}`);
    expect(routing.tokenRequests).toHaveLength(1);

    // The retry must carry the refreshed credential. Re-sending the rejected one makes the
    // retry pointless and surfaces to the user as "sign in again" when a refresh would have
    // fixed it.
    expect(routing.apiRequests[1]?.authorization).toBe(`Bearer ${REFRESHED_ACCESS_TOKEN}`);

    // The refreshed token is persisted, and the refresh token the provider never re-sent is
    // preserved rather than dropped.
    const state = readTokenStore({ storeRoot: home.path });
    expect(state.status).toBe("present");
    if (state.status === "present") {
      expect(state.tokens.accessToken).toBe(REFRESHED_ACCESS_TOKEN);
      expect(state.tokens.refreshToken).toBe(STORED.refreshToken);
    }
  });
});
