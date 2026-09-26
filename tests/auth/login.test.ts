import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTokenStore } from "../../src/auth/token-store.js";
import { login } from "../../src/auth/login.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

// Disjoint from every port range the other auth test files inject, so this file can run in
// parallel with them without a spurious EADDRINUSE.
const PORT_RANGE = { first: 20184, last: 20189 };

const SUCCESSFUL_TOKEN_RESPONSE = {
  status: 200,
  json: {
    access_token: "access-abc",
    refresh_token: "refresh-def",
    id_token: "id-ghi",
    token_type: "Bearer",
    expires_in: 3600,
  },
};

/** A launchBrowser that completes the flow itself, exactly as a browser+user would, by hitting
 * the real local callback server with a real fetch. */
function completingLauncher(outcome: { code: string } | { error: string; description?: string }) {
  return (authorizeUrl: string): void => {
    const parsed = new URL(authorizeUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri");
    const state = parsed.searchParams.get("state");
    if (!redirectUri || !state) {
      throw new Error("test launcher: authorize URL is missing redirect_uri or state");
    }
    const callbackUrl = new URL(redirectUri);
    if ("code" in outcome) {
      callbackUrl.searchParams.set("code", outcome.code);
    } else {
      callbackUrl.searchParams.set("error", outcome.error);
      if (outcome.description) {
        callbackUrl.searchParams.set("error_description", outcome.description);
      }
    }
    callbackUrl.searchParams.set("state", state);
    void fetch(callbackUrl.toString());
  };
}

describe("login", () => {
  let home: TempHome;

  beforeEach(() => {
    home = createTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it("stores tokens after a full round trip", async () => {
    const fake = createFakeFetch([SUCCESSFUL_TOKEN_RESPONSE]);

    await login({
      storeRoot: home.path,
      fetchFn: fake.fetch,
      print: () => {},
      now: () => 1_700_000_000_000,
      callbackServerOptions: { portRange: PORT_RANGE },
      launchBrowser: completingLauncher({ code: "auth-code-123" }),
    });

    expect(readTokenStore({ storeRoot: home.path })).toEqual({
      status: "present",
      tokens: {
        accessToken: "access-abc",
        refreshToken: "refresh-def",
        idToken: "id-ghi",
        tokenType: "Bearer",
        expiresIn: 3600,
        obtainedAt: 1_700_000_000_000,
      },
    });
  });

  it("sends the same redirect uri to the token endpoint that it put in the authorize URL", async () => {
    const fake = createFakeFetch([SUCCESSFUL_TOKEN_RESPONSE]);
    let redirectUriSeenByLauncher = "";

    await login({
      storeRoot: home.path,
      fetchFn: fake.fetch,
      print: () => {},
      callbackServerOptions: { portRange: PORT_RANGE },
      launchBrowser: (authorizeUrl) => {
        redirectUriSeenByLauncher = new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "";
        completingLauncher({ code: "auth-code-123" })(authorizeUrl);
      },
    });

    expect(redirectUriSeenByLauncher).not.toBe("");
    expect(fake.calls).toHaveLength(1);
    const body = new URLSearchParams(fake.calls[0]!.init?.body as string);
    expect(body.get("redirect_uri")).toBe(redirectUriSeenByLauncher);
  });

  it("prints the authorize URL even when the browser launcher throws", async () => {
    const fake = createFakeFetch([SUCCESSFUL_TOKEN_RESPONSE]);
    let printed = "";

    await login({
      storeRoot: home.path,
      fetchFn: fake.fetch,
      print: (message) => {
        printed += message;
      },
      callbackServerOptions: { portRange: PORT_RANGE },
      launchBrowser: (authorizeUrl) => {
        // Complete the flow first (as if a human manually pasted the printed URL after the
        // launcher failed), then throw to prove login() must tolerate the launcher failing.
        completingLauncher({ code: "auth-code-123" })(authorizeUrl);
        throw new Error("no display found");
      },
    });

    expect(printed).toContain("https://oauth.awsevents.com/oauth2/authorize");
    expect(readTokenStore({ storeRoot: home.path }).status).toBe("present");
  });

  it("rejects and stores nothing when the token response omits a refresh token", async () => {
    const fake = createFakeFetch([
      {
        status: 200,
        json: {
          access_token: "access-abc",
          id_token: "id-ghi",
          token_type: "Bearer",
          expires_in: 3600,
          // No refresh_token: the provider is only required to omit this on a refresh grant, but
          // a login (authorization_code grant) response with no refresh token leaves nothing for
          // the token provider to ever silently refresh with, so it must be rejected rather than
          // stored as a session that looks valid until the access token expires.
        },
      },
    ]);

    await expect(
      login({
        storeRoot: home.path,
        fetchFn: fake.fetch,
        print: () => {},
        callbackServerOptions: { portRange: PORT_RANGE },
        launchBrowser: completingLauncher({ code: "auth-code-123" }),
      }),
    ).rejects.toThrow(/refresh token/);

    expect(readTokenStore({ storeRoot: home.path })).toEqual({ status: "absent" });
  });

  it("aborts without storing anything when the callback carries an error", async () => {
    const fake = createFakeFetch([SUCCESSFUL_TOKEN_RESPONSE]);

    await expect(
      login({
        storeRoot: home.path,
        fetchFn: fake.fetch,
        print: () => {},
        callbackServerOptions: { portRange: PORT_RANGE },
        launchBrowser: completingLauncher({
          error: "access_denied",
          description: "User declined consent",
        }),
      }),
    ).rejects.toThrow(/access_denied/);

    expect(fake.calls).toHaveLength(0);
    expect(readTokenStore({ storeRoot: home.path })).toEqual({ status: "absent" });
  });
});
