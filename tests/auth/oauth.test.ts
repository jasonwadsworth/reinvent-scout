import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  IDENTITY_PROVIDER,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  OAuthError,
} from "../../src/auth/oauth.js";
import { createFakeFetch } from "../helpers/fake-fetch.js";

describe("buildAuthorizeUrl", () => {
  it("builds an authorize URL with response_type, client id, redirect uri, scope, identity_provider, challenge, S256 method and state", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://localhost:8486/callback",
        codeChallenge: "challenge-value",
        state: "state-value",
      }),
    );

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8486/callback");
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPE);
    expect(url.searchParams.get("identity_provider")).toBe(IDENTITY_PROVIDER);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
  });
});

describe("exchangeCodeForTokens", () => {
  it("exchanges the code with grant_type authorization_code and the matching redirect uri and verifier", async () => {
    const fake = createFakeFetch([
      {
        status: 200,
        json: {
          access_token: "access-abc",
          refresh_token: "refresh-def",
          id_token: "id-ghi",
          token_type: "Bearer",
          expires_in: 3600,
        },
      },
    ]);

    const tokens = await exchangeCodeForTokens({
      code: "auth-code",
      redirectUri: "http://localhost:8486/callback",
      codeVerifier: "verifier-value",
      fetchFn: fake.fetch,
    });

    expect(tokens).toEqual({
      accessToken: "access-abc",
      refreshToken: "refresh-def",
      idToken: "id-ghi",
      tokenType: "Bearer",
      expiresIn: 3600,
    });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    const body = new URLSearchParams(call.init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(body.get("redirect_uri")).toBe("http://localhost:8486/callback");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-value");
  });

  it("surfaces the provider error_description when the token endpoint returns 400", async () => {
    const fake = createFakeFetch([
      {
        status: 400,
        json: { error: "invalid_grant", error_description: "The authorization code is invalid or expired." },
      },
    ]);

    await expect(
      exchangeCodeForTokens({
        code: "auth-code",
        redirectUri: "http://localhost:8486/callback",
        codeVerifier: "verifier-value",
        fetchFn: fake.fetch,
      }),
    ).rejects.toThrow(/authorization code is invalid or expired/i);
  });

  it("surfaces a clear error when the token endpoint returns a non-JSON body", async () => {
    const fake = createFakeFetch([
      {
        status: 502,
        text: "<html>Bad Gateway</html>",
      },
    ]);

    await expect(
      exchangeCodeForTokens({
        code: "auth-code",
        redirectUri: "http://localhost:8486/callback",
        codeVerifier: "verifier-value",
        fetchFn: fake.fetch,
      }),
    ).rejects.toThrow(OAuthError);
  });
});
